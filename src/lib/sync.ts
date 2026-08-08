import { prisma } from "@/lib/prisma";
import {
  fetchParsedMessage,
  getProfileHistoryId,
  listCandidateMessageIds,
  listHistoryMessageIds,
  startGmailWatch,
} from "@/lib/gmail";
import { classifyWithRules } from "@/lib/classify/rules";
import { classifyEmail } from "@/lib/classify/llm";
import {
  findMatchingApplication,
  refreshApplicationStatus,
} from "@/lib/classify/match";
import {
  appendEmailToSheet,
  ensureUserSpreadsheet,
  syncApplicationToSheet,
} from "@/lib/sheets";

export type SyncSummary = {
  scanned: number;
  createdApplications: number;
  updatedApplications: number;
  skipped: number;
  sheetUrl: string | null;
  errors: string[];
};

function formatGoogleApiError(err: unknown): string {
  const cause = (err as { cause?: { message?: string; status?: string } })?.cause;
  if (cause?.message) return cause.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

async function processMessage(
  userId: string,
  messageId: string,
  summary: SyncSummary
) {
  const existing = await prisma.emailEvent.findUnique({
    where: {
      userId_gmailMessageId: { userId, gmailMessageId: messageId },
    },
  });
  if (existing) {
    summary.skipped += 1;
    return;
  }

  const message = await fetchParsedMessage(userId, messageId);
  if (!message) {
    summary.skipped += 1;
    return;
  }

  summary.scanned += 1;

  const rules = classifyWithRules(message);
  const classification = await classifyEmail(message, rules);

  if (!classification.isJobRelated) {
    await prisma.emailEvent.create({
      data: {
        userId,
        gmailMessageId: message.gmailMessageId,
        gmailThreadId: message.gmailThreadId,
        receivedAt: message.receivedAt,
        fromAddress: message.fromAddress,
        subject: message.subject,
        snippet: message.snippet,
        bodyExcerpt: message.bodyExcerpt,
        inferredStatus: classification.status,
        isJobRelated: false,
        confidence: classification.confidence,
        classifyReason: classification.reason,
        gmailLink: message.gmailLink,
      },
    });
    summary.skipped += 1;
    return;
  }

  // Need a real company name — never create "Unknown company" rows from weak mail
  const company = classification.company?.trim();
  if (!company) {
    await prisma.emailEvent.create({
      data: {
        userId,
        gmailMessageId: message.gmailMessageId,
        gmailThreadId: message.gmailThreadId,
        receivedAt: message.receivedAt,
        fromAddress: message.fromAddress,
        subject: message.subject,
        snippet: message.snippet,
        bodyExcerpt: message.bodyExcerpt,
        inferredStatus: classification.status,
        isJobRelated: false,
        confidence: "low",
        classifyReason: `no-company; ${classification.reason}`,
        gmailLink: message.gmailLink,
      },
    });
    summary.skipped += 1;
    return;
  }

  let application = await findMatchingApplication(
    userId,
    message,
    { ...classification, company }
  );

  if (!application) {
    application = await prisma.application.create({
      data: {
        userId,
        company,
        role: classification.role,
        appliedAt: classification.appliedAt ?? message.receivedAt,
        status: classification.status,
        confidence: classification.confidence,
      },
    });
    summary.createdApplications += 1;
  } else {
    const data: {
      role?: string;
      appliedAt?: Date;
      confidence?: string;
      company?: string;
    } = { confidence: classification.confidence };
    if (!application.role && classification.role) data.role = classification.role;
    if (!application.appliedAt && classification.appliedAt) {
      data.appliedAt = classification.appliedAt;
    }
    // Upgrade placeholder-ish company names when we extract a better one
    if (
      company &&
      (/^unknown/i.test(application.company) || application.company.length < 2)
    ) {
      data.company = company;
    }
    application = await prisma.application.update({
      where: { id: application.id },
      data,
    });
    summary.updatedApplications += 1;
  }

  const event = await prisma.emailEvent.create({
    data: {
      userId,
      applicationId: application.id,
      gmailMessageId: message.gmailMessageId,
      gmailThreadId: message.gmailThreadId,
      receivedAt: message.receivedAt,
      fromAddress: message.fromAddress,
      subject: message.subject,
      snippet: message.snippet,
      bodyExcerpt: message.bodyExcerpt,
      inferredStatus: classification.status,
      isJobRelated: true,
      confidence: classification.confidence,
      classifyReason: classification.reason,
      gmailLink: message.gmailLink,
    },
  });

  await refreshApplicationStatus(application.id);

  try {
    await syncApplicationToSheet(userId, application.id);
    await appendEmailToSheet(userId, event.id);
  } catch (err) {
    summary.errors.push(
      `Sheet sync failed for ${application.company}: ${formatGoogleApiError(err)}`
    );
  }
}

export async function syncUserMailbox(
  userId: string,
  options: {
    newerThanDays?: number;
    maxPages?: number;
    /** Delete previously rejected/non-job email rows so improved classifiers can reconsider them. */
    reclassifySkipped?: boolean;
  } = {}
): Promise<SyncSummary> {
  const summary: SyncSummary = {
    scanned: 0,
    createdApplications: 0,
    updatedApplications: 0,
    skipped: 0,
    sheetUrl: null,
    errors: [],
  };

  if (options.reclassifySkipped) {
    const deleted = await prisma.emailEvent.deleteMany({
      where: { userId, isJobRelated: false },
    });
    if (deleted.count > 0) {
      summary.errors.push(
        `Reclassify: cleared ${deleted.count} previously skipped email(s) for a fresh look`
      );
    }
  }

  try {
    const sheetId = await ensureUserSpreadsheet(userId);
    summary.sheetUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/edit`;
  } catch (err) {
    summary.errors.push(`Could not create/open Sheet: ${formatGoogleApiError(err)}`);
  }

  const maxPages = options.maxPages ?? 12;
  let pageToken: string | undefined;
  let pages = 0;

  try {
    do {
      const page = await listCandidateMessageIds(userId, {
        newerThanDays: options.newerThanDays ?? 90,
        maxResults: 50,
        pageToken,
      });

      for (const id of page.ids) {
        try {
          await processMessage(userId, id, summary);
        } catch (err) {
          summary.errors.push(`Message ${id}: ${formatGoogleApiError(err)}`);
        }
      }

      pageToken = page.nextPageToken;
      pages += 1;
    } while (pageToken && pages < maxPages);
  } catch (err) {
    summary.errors.push(`Gmail list failed: ${formatGoogleApiError(err)}`);
    throw Object.assign(new Error(formatGoogleApiError(err)), { summary });
  }

  try {
    const historyId = await getProfileHistoryId(userId);
    await prisma.user.update({
      where: { id: userId },
      data: {
        gmailHistoryId: historyId || undefined,
        lastSyncedAt: new Date(),
      },
    });
  } catch (err) {
    summary.errors.push(
      `Could not save historyId: ${formatGoogleApiError(err)}`
    );
  }

  return summary;
}

export async function syncFromHistory(userId: string): Promise<SyncSummary> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user?.gmailHistoryId) {
    return syncUserMailbox(userId, { newerThanDays: 7, maxPages: 2 });
  }

  const summary: SyncSummary = {
    scanned: 0,
    createdApplications: 0,
    updatedApplications: 0,
    skipped: 0,
    sheetUrl: user.sheetId
      ? `https://docs.google.com/spreadsheets/d/${user.sheetId}/edit`
      : null,
    errors: [],
  };

  const { messageIds, newHistoryId } = await listHistoryMessageIds(
    userId,
    user.gmailHistoryId
  );

  if (messageIds.length === 0 && !newHistoryId) {
    return syncUserMailbox(userId, { newerThanDays: 14, maxPages: 3 });
  }

  for (const id of messageIds) {
    try {
      await processMessage(userId, id, summary);
    } catch (err) {
      summary.errors.push(`Message ${id}: ${formatGoogleApiError(err)}`);
    }
  }

  const historyId = newHistoryId ?? (await getProfileHistoryId(userId));
  await prisma.user.update({
    where: { id: userId },
    data: {
      gmailHistoryId: historyId || user.gmailHistoryId,
      lastSyncedAt: new Date(),
    },
  });

  return summary;
}

export async function renewGmailWatchForUser(userId: string) {
  const topic = process.env.GMAIL_PUBSUB_TOPIC;
  if (!topic) throw new Error("GMAIL_PUBSUB_TOPIC is not configured");

  const watch = await startGmailWatch(userId, topic);
  await prisma.user.update({
    where: { id: userId },
    data: {
      gmailHistoryId: watch.historyId ?? undefined,
      gmailWatchExpiry: watch.expiration,
    },
  });
  return watch;
}
