import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { renewGmailWatchForUser, syncFromHistory } from "@/lib/sync";

function isAuthorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  const authHeader = request.headers.get("authorization");
  if (secret && authHeader === `Bearer ${secret}`) return true;
  if (request.headers.get("x-vercel-cron") === "1") return true;
  return false;
}

export async function GET(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const users = await prisma.user.findMany({
    where: { accounts: { some: { provider: "google" } } },
    select: { id: true, gmailWatchExpiry: true },
  });

  const results: {
    userId: string;
    watch?: string;
    sync?: unknown;
    error?: string;
  }[] = [];

  const soon = Date.now() + 24 * 60 * 60 * 1000;
  const topicConfigured = Boolean(process.env.GMAIL_PUBSUB_TOPIC);

  for (const user of users) {
    const entry: (typeof results)[number] = { userId: user.id };
    try {
      if (
        topicConfigured &&
        (!user.gmailWatchExpiry || user.gmailWatchExpiry.getTime() < soon)
      ) {
        await renewGmailWatchForUser(user.id);
        entry.watch = "renewed";
      }
      entry.sync = await syncFromHistory(user.id);
    } catch (err) {
      entry.error = err instanceof Error ? err.message : String(err);
    }
    results.push(entry);
  }

  return NextResponse.json({ ok: true, results });
}
