import type { gmail_v1 } from "googleapis";
import { getGmailClient } from "@/lib/google";
import { gmailMessageLink } from "@/lib/types";

export type ParsedGmailMessage = {
  gmailMessageId: string;
  gmailThreadId: string | null;
  receivedAt: Date;
  fromAddress: string;
  subject: string;
  snippet: string;
  bodyExcerpt: string;
  gmailLink: string;
};

function headerValue(
  headers: gmail_v1.Schema$MessagePartHeader[] | undefined,
  name: string
): string {
  const found = headers?.find(
    (h) => h.name?.toLowerCase() === name.toLowerCase()
  );
  return found?.value ?? "";
}

function decodeBodyData(data?: string | null): string {
  if (!data) return "";
  const normalized = data.replace(/-/g, "+").replace(/_/g, "/");
  try {
    return Buffer.from(normalized, "base64").toString("utf8");
  } catch {
    return "";
  }
}

function extractTextFromPayload(payload?: gmail_v1.Schema$MessagePart): string {
  if (!payload) return "";

  if (payload.mimeType === "text/plain" && payload.body?.data) {
    return decodeBodyData(payload.body.data);
  }

  if (payload.parts?.length) {
    for (const part of payload.parts) {
      if (part.mimeType === "text/plain") {
        const text = extractTextFromPayload(part);
        if (text) return text;
      }
    }
    for (const part of payload.parts) {
      if (part.mimeType === "text/html") {
        const html = extractTextFromPayload(part);
        if (html) return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
      }
      const nested = extractTextFromPayload(part);
      if (nested) return nested;
    }
  }

  if (payload.body?.data) {
    return decodeBodyData(payload.body.data);
  }

  return "";
}

export function parseGmailMessage(
  message: gmail_v1.Schema$Message
): ParsedGmailMessage | null {
  if (!message.id) return null;

  const headers = message.payload?.headers;
  const subject = headerValue(headers, "Subject") || "(no subject)";
  const fromAddress = headerValue(headers, "From") || "unknown";
  const dateHeader = headerValue(headers, "Date");
  const internalDate = message.internalDate
    ? Number(message.internalDate)
    : NaN;
  const receivedAt = !Number.isNaN(internalDate)
    ? new Date(internalDate)
    : dateHeader
      ? new Date(dateHeader)
      : new Date();

  const body = extractTextFromPayload(message.payload);
  const bodyExcerpt = body.slice(0, 2500).trim();

  return {
    gmailMessageId: message.id,
    gmailThreadId: message.threadId ?? null,
    receivedAt,
    fromAddress,
    subject,
    snippet: message.snippet ?? "",
    bodyExcerpt,
    gmailLink: gmailMessageLink(message.id),
  };
}

/** Prefer confirmation / pipeline language; still includes ATS senders for stage updates. */
export const JOB_MAIL_QUERY =
  "(" +
  [
    'subject:("thank you for applying" OR "application received" OR "we received your application" OR "application submitted" OR "your application" OR interview OR assessment OR "under review" OR "unfortunately" OR "offer")',
    "from:(greenhouse.io OR lever.co OR myworkday.com OR ashbyhq.com OR workable.com OR icims.com OR successfactors.com OR smartrecruiters.com OR jobvite.com OR taleo.net OR brassring.com)",
  ].join(" OR ") +
  ') -category:promotions -unsubscribe -("job alert" OR "jobs for you" OR "new openings" OR "recommended jobs" OR "jobs matching")';

export async function listCandidateMessageIds(
  userId: string,
  options: { newerThanDays?: number; maxResults?: number; pageToken?: string } = {}
) {
  const gmail = await getGmailClient(userId);
  const newerThanDays = options.newerThanDays ?? 90;
  const q = `${JOB_MAIL_QUERY} newer_than:${newerThanDays}d`;

  const res = await gmail.users.messages.list({
    userId: "me",
    q,
    maxResults: options.maxResults ?? 50,
    pageToken: options.pageToken,
  });

  return {
    ids: (res.data.messages ?? []).map((m) => m.id!).filter(Boolean),
    nextPageToken: res.data.nextPageToken ?? undefined,
  };
}

export async function fetchParsedMessage(
  userId: string,
  messageId: string
): Promise<ParsedGmailMessage | null> {
  const gmail = await getGmailClient(userId);
  const res = await gmail.users.messages.get({
    userId: "me",
    id: messageId,
    format: "full",
  });
  return parseGmailMessage(res.data);
}

export async function getProfileHistoryId(userId: string): Promise<string> {
  const gmail = await getGmailClient(userId);
  const profile = await gmail.users.getProfile({ userId: "me" });
  return String(profile.data.historyId ?? "");
}

export async function listHistoryMessageIds(
  userId: string,
  startHistoryId: string
): Promise<{ messageIds: string[]; newHistoryId?: string }> {
  const gmail = await getGmailClient(userId);
  const messageIds = new Set<string>();
  let pageToken: string | undefined;
  let newHistoryId: string | undefined;

  try {
    do {
      const res = await gmail.users.history.list({
        userId: "me",
        startHistoryId,
        historyTypes: ["messageAdded"],
        pageToken,
      });
      newHistoryId = res.data.historyId
        ? String(res.data.historyId)
        : newHistoryId;
      for (const h of res.data.history ?? []) {
        for (const added of h.messagesAdded ?? []) {
          if (added.message?.id) messageIds.add(added.message.id);
        }
      }
      pageToken = res.data.nextPageToken ?? undefined;
    } while (pageToken);
  } catch (err: unknown) {
    const status = (err as { code?: number })?.code;
    if (status === 404) {
      return { messageIds: [], newHistoryId: undefined };
    }
    throw err;
  }

  return { messageIds: [...messageIds], newHistoryId };
}

export async function startGmailWatch(userId: string, topicName: string) {
  const gmail = await getGmailClient(userId);
  const res = await gmail.users.watch({
    userId: "me",
    requestBody: {
      topicName,
      labelIds: ["INBOX"],
    },
  });
  return {
    historyId: res.data.historyId ? String(res.data.historyId) : undefined,
    expiration: res.data.expiration
      ? new Date(Number(res.data.expiration))
      : undefined,
  };
}
