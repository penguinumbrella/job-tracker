import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getActiveLlmProvider } from "@/lib/classify/llm";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const provider = getActiveLlmProvider();
  return NextResponse.json({
    llmProvider: provider,
    geminiModel:
      provider === "gemini"
        ? process.env.GEMINI_MODEL?.trim() || "gemini-2.0-flash"
        : null,
    tips:
      provider === "none"
        ? "Add GEMINI_API_KEY to .env for free-tier classification (Google AI Studio)."
        : provider === "gemini"
          ? "Using Gemini in batches of ~10 emails/request. Prefer Test sync (14d) on free tier."
          : "Using OpenAI in batches of ~10. Prefer Test sync (14d) while evaluating spend.",
  });
}
