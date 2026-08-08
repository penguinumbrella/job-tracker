import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { isJobStatus } from "@/lib/types";
import { refreshApplicationStatus } from "@/lib/classify/match";
import { syncApplicationToSheet } from "@/lib/sheets";

type Params = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const body = (await request.json()) as {
    company?: string;
    role?: string | null;
    statusOverride?: string | null;
    clearStatusOverride?: boolean;
    dismissed?: boolean;
    notes?: string | null;
  };

  const existing = await prisma.application.findFirst({
    where: { id, userId: session.user.id },
  });
  if (!existing) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const data: Record<string, unknown> = {};
  if (typeof body.company === "string" && body.company.trim()) {
    data.company = body.company.trim();
  }
  if (body.role !== undefined) data.role = body.role;
  if (body.notes !== undefined) data.notes = body.notes;
  if (typeof body.dismissed === "boolean") data.dismissed = body.dismissed;

  if (body.clearStatusOverride) {
    data.statusOverride = null;
  } else if (body.statusOverride !== undefined) {
    if (body.statusOverride === null) {
      data.statusOverride = null;
    } else if (isJobStatus(body.statusOverride)) {
      data.statusOverride = body.statusOverride;
      data.status = body.statusOverride;
    } else {
      return NextResponse.json({ error: "Invalid status" }, { status: 400 });
    }
  }

  await prisma.application.update({ where: { id }, data });
  await refreshApplicationStatus(id);

  try {
    await syncApplicationToSheet(session.user.id, id);
  } catch {
    // best-effort
  }

  const updated = await prisma.application.findUnique({
    where: { id },
    include: {
      emails: {
        where: { isJobRelated: true },
        orderBy: { receivedAt: "desc" },
        take: 5,
      },
    },
  });

  return NextResponse.json(updated);
}
