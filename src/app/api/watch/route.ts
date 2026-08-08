import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { renewGmailWatchForUser } from "@/lib/sync";

export async function POST() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!process.env.GMAIL_PUBSUB_TOPIC) {
    return NextResponse.json(
      {
        error:
          "GMAIL_PUBSUB_TOPIC not set. Polling via Sync / cron still works without push.",
      },
      { status: 400 }
    );
  }

  try {
    const watch = await renewGmailWatchForUser(session.user.id);
    return NextResponse.json({ ok: true, watch });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
