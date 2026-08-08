import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { syncUserMailbox } from "@/lib/sync";
import { getActiveLlmProvider } from "@/lib/classify/llm";

/**
 * Wipe synced email events (and applications) for a fresh classify pass, then
 * run a low-cost test sync (14 days / 2 pages).
 */
export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await request.json().catch(() => ({}))) as {
    clearApplications?: boolean;
    resync?: boolean;
    newerThanDays?: number;
    maxPages?: number;
  };

  const userId = session.user.id;
  const clearApplications = body.clearApplications ?? true;
  const resync = body.resync ?? true;

  const deletedEvents = await prisma.emailEvent.deleteMany({ where: { userId } });

  let deletedApplications = 0;
  if (clearApplications) {
    const result = await prisma.application.deleteMany({ where: { userId } });
    deletedApplications = result.count;
  } else {
    await prisma.application.updateMany({
      where: { userId },
      data: { statusSourceEmailId: null, sheetRowNumber: null },
    });
  }

  let summary = null;
  if (resync) {
    summary = await syncUserMailbox(userId, {
      newerThanDays: body.newerThanDays ?? 14,
      maxPages: body.maxPages ?? 2,
      reclassifySkipped: false,
    });
  }

  return NextResponse.json({
    ok: true,
    deletedEvents: deletedEvents.count,
    deletedApplications,
    llmProvider: getActiveLlmProvider(),
    mode: resync ? "test" : "clear-only",
    summary,
  });
}
