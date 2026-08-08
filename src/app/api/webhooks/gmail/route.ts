import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { syncFromHistory } from "@/lib/sync";

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  if (!body?.message?.data) {
    return NextResponse.json({ ok: true, ignored: true });
  }

  let decoded: { emailAddress?: string; historyId?: string | number };
  try {
    const json = Buffer.from(body.message.data, "base64").toString("utf8");
    decoded = JSON.parse(json);
  } catch {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }

  const email = decoded.emailAddress;
  if (!email) return NextResponse.json({ ok: true, ignored: true });

  const user = await prisma.user.findFirst({
    where: { email: { equals: email } },
  });
  if (!user) return NextResponse.json({ ok: true, unknownUser: true });

  const summary = await syncFromHistory(user.id);
  return NextResponse.json({ ok: true, summary });
}
