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
      orderBy: [{ updatedAt: "desc" }],
    }),
    prisma.user.findUnique({ where: { id: session.user.id } }),
  ]);

  return NextResponse.json({
    applications,
    lastSyncedAt: user?.lastSyncedAt ?? null,
    sheetUrl: user?.sheetId ? spreadsheetUrl(user.sheetId) : null,
    gmailWatchExpiry: user?.gmailWatchExpiry ?? null,
  });
}
