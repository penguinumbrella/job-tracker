import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { spreadsheetUrl } from "@/lib/sheets";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const [applications, user] = await Promise.all([
    prisma.application.findMany({
      where: { userId: session.user.id, dismissed: false },
      include: {
        emails: {
          where: { isJobRelated: true },
          orderBy: { receivedAt: "desc" },
          take: 5,
        },
      },
      // appliedAt desc first; createdAt as tiebreaker (SQLite puts nulls first — we re-sort below)
      orderBy: [{ appliedAt: "desc" }, { createdAt: "desc" }],
    }),
    prisma.user.findUnique({ where: { id: session.user.id } }),
  ]);

  // Newest applications first; rows without appliedAt sink to the bottom
  const sorted = [...applications].sort((a, b) => {
    const aTime = a.appliedAt?.getTime() ?? 0;
    const bTime = b.appliedAt?.getTime() ?? 0;
    if (aTime !== bTime) return bTime - aTime;
    return b.createdAt.getTime() - a.createdAt.getTime();
  });

  return NextResponse.json({
    applications: sorted,
    lastSyncedAt: user?.lastSyncedAt ?? null,
    sheetUrl: user?.sheetId ? spreadsheetUrl(user.sheetId) : null,
    gmailWatchExpiry: user?.gmailWatchExpiry ?? null,
  });
}
