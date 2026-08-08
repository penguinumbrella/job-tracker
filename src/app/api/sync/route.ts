import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { syncFromHistory, syncUserMailbox } from "@/lib/sync";

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await request.json().catch(() => ({}))) as {
    mode?: "full" | "incremental";
    newerThanDays?: number;
  };

  try {
    const summary =
      body.mode === "incremental"
        ? await syncFromHistory(session.user.id)
        : await syncUserMailbox(session.user.id, {
            newerThanDays: body.newerThanDays ?? 90,
          });
    return NextResponse.json(summary);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const summary = (err as { summary?: unknown })?.summary;
    return NextResponse.json(
      { error: message, summary: summary ?? null },
      { status: 500 }
    );
  }
}
