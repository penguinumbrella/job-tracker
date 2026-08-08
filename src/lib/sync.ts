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
  if (!rules.isLikelyJob) {
    summary.skipped += 1;
    return;
  }

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

  let application = await findMatchingApplication(
    userId,
    message,
    classification
  );
  let created = false;

  if (!application) {
    application = await prisma.application.create({
      data: {
        userId,
        company: classification.company || "Unknown company",
        role: classification.role,
        appliedAt: classification.appliedAt ?? message.receivedAt,
        status: classification.status,
        confidence: classification.confidence,
      },
    });
    created = true;
    summary.createdApplications += 1;
  } else {
    const data: {
      role?: string;
      appliedAt?: Date;
      confidence?: string;
    } = {};
    if (!application.role && classification.role) data.role = classification.role;
    if (!application.appliedAt && classification.appliedAt) {
      data.appliedAt = classification.appliedAt;
    }
    data.confidence = classification.confidence;
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
      `Sheet sync failed for ${application.company}: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  if (created) {
    // already counted
  }
}

export async function syncUserMailbox(
  userId: string,
  options: { newerThanDays?: number; maxPages?: number } = {}
): Promise<SyncSummary> {
  const summary: SyncSummary = {
    scanned: 0,
    createdApplications: 0,
    updatedApplications: 0,
    skipped: 0,
    sheetUrl: null,
    errors: [],
  };

  try {
    const sheetId = await ensureUserSpreadsheet(userId);
    summary.sheetUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/edit`;
  } catch (err) {
    summary.errors.push(
      `Could not create/open Sheet: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  const maxPages = options.maxPages ?? 5;
  let pageToken: string | undefined;
  let pages = 0;

  do {
    const page = await listCandidateMessageIds(userId, {
      newerThanDays: options.newerThanDays ?? 90,
      maxResults: 40,
      pageToken,
    });

    for (const id of page.ids) {
      try {
        await processMessage(userId, id, summary);
      } catch (err) {
        summary.errors.push(
          `Message ${id}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    pageToken = page.nextPageToken;
    pages += 1;
  } while (pageToken && pages < maxPages);

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
      `Could not save historyId: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  return summary;
}

export async function syncFromHistory(userId: string): Promise<SyncSummary> {
  const summary: SyncSummary = {
    scanned: 0,
    createdApplications: 0,
    updatedApplications: 0,
    skipped: 0,
    sheetUrl: null,
    errors: [],
  };

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user?.gmailHistoryId) {
    return syncUserMailbox(userId, { newerThanDays: 7, maxPages: 2 });
  }

  const { messageIds, newHistoryId } = await listHistoryMessageIds(
    userId,
    user.gmailHistoryId
  );

  if (messageIds.length === 0 && !newHistoryId) {
    // history expired — full recent resync
    return syncUserMailbox(userId, { newerThanDays: 14, maxPages: 3 });
  }

  for (const id of messageIds) {
    try {
      await processMessage(userId, id, summary);
    } catch (err) {
      summary.errors.push(
        `Message ${id}: ${err instanceof Error ? err.message : String(err)}`
      );
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

  if (user.sheetId) {
    summary.sheetUrl = `https://docs.google.com/spreadsheets/d/${user.sheetId}/edit`;
  }

  return summary;
}

export async function renewGmailWatchForUser(userId: string) {
  const topic = process.env.GMAIL_PUBSUB_TOPIC;
  if (!topic) {
    throw new Error("GMAIL_PUBSUB_TOPIC is not configured");
  }

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
