import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { syncFromHistory, syncUserMailbox } from "@/lib/sync";
import { getActiveLlmProvider } from "@/lib/classify/llm";

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await request.json().catch(() => ({}))) as {
    mode?: "full" | "incremental" | "test";
    newerThanDays?: number;
    maxPages?: number;
    reclassifySkipped?: boolean;
  };

  const mode = body.mode ?? "test";

  try {
    let summary;
    if (mode === "incremental") {
      summary = await syncFromHistory(session.user.id);
    } else if (mode === "test") {
      // Cheap Gemini free-tier friendly defaults
      summary = await syncUserMailbox(session.user.id, {
        newerThanDays: body.newerThanDays ?? 14,
        maxPages: body.maxPages ?? 2,
        reclassifySkipped: body.reclassifySkipped ?? false,
      });
    } else {
      summary = await syncUserMailbox(session.user.id, {
        newerThanDays: body.newerThanDays ?? 90,
        maxPages: body.maxPages ?? 12,
        reclassifySkipped: body.reclassifySkipped ?? true,
      });
    }

    return NextResponse.json({
      ...summary,
      mode,
      llmProvider: getActiveLlmProvider(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const summary = (err as { summary?: unknown })?.summary;
    return NextResponse.json(
      { error: message, summary: summary ?? null },
      { status: 500 }
    );
  }
}
