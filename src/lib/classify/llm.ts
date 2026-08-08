import { GoogleGenerativeAI } from "@google/generative-ai";
import OpenAI from "openai";
import { z } from "zod";
import type { ParsedGmailMessage } from "@/lib/gmail";
import type { RuleClassification } from "@/lib/classify/rules";
import { JOB_STATUSES, type JobStatus } from "@/lib/types";

/** Keep prompts short + body capped to save free-tier tokens. */
const BODY_EXCERPT_CHARS = 1200;

/**
 * Gemini free tier is often ~5–15 RPM. Space calls out and cap per sync.
 * Override with LLM_MIN_INTERVAL_MS / LLM_MAX_CALLS_PER_SYNC in .env
 */
const MIN_INTERVAL_MS = Number(process.env.LLM_MIN_INTERVAL_MS ?? 4500);
const MAX_CALLS_PER_SYNC = Number(process.env.LLM_MAX_CALLS_PER_SYNC ?? 12);
const MAX_RETRIES = 3;

const ExtractionSchema = z.object({
  isJobRelated: z.boolean(),
  company: z.string().nullable(),
  role: z.string().nullable(),
  status: z.enum(JOB_STATUSES),
  appliedDate: z.string().nullable(),
  confidence: z.enum(["high", "medium", "low"]),
  reason: z.string(),
});

export type ClassificationResult = {
  isJobRelated: boolean;
  company: string | null;
  role: string | null;
  status: JobStatus;
  appliedAt: Date | null;
  confidence: "high" | "medium" | "low";
  reason: string;
  source: "rules" | "llm" | "hybrid";
};

export type LlmSyncStats = {
  calls: number;
  rateLimitedFallbacks: number;
  budgetExhaustedFallbacks: number;
};

let lastLlmCallAt = 0;
let llmCallsThisSync = 0;
let rateLimitedFallbacks = 0;
let budgetExhaustedFallbacks = 0;

/** Call at the start of each mailbox sync. */
export function resetLlmBudget() {
  llmCallsThisSync = 0;
  rateLimitedFallbacks = 0;
  budgetExhaustedFallbacks = 0;
  // Don't reset lastLlmCallAt — still respect spacing across syncs in the same process
}

export function getLlmSyncStats(): LlmSyncStats {
  return {
    calls: llmCallsThisSync,
    rateLimitedFallbacks,
    budgetExhaustedFallbacks,
  };
}

const SYSTEM_PROMPT = `Classify one inbox email for a personal job APPLICATION tracker. Reply with JSON only.

isJobRelated=true only if the recipient already applied, or this is a later stage update (review/assessment invite/scheduled interview/offer/rejection/withdrawal).
isJobRelated=false for alerts, digests, new openings, apply-bots, cold outreach, newsletters.

status:
- applied: submission/received confirmation (even if it mentions a future "interview process")
- under_review: actively reviewing their application
- assessment: they must take a test/Hackerrank/take-home now
- interview: ONLY invited/scheduled/confirmed interview — not the word "interview" alone
- offer|rejected|withdrawn|unknown

Extract company (never "Unknown"; null if unclear), role/title (null if absent), appliedDate ISO or null, confidence, short reason.

Keys: isJobRelated, company, role, status, appliedDate, confidence, reason`;

function parseAppliedDate(value: string | null): Date | null {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

function fromRules(
  message: ParsedGmailMessage,
  rules: RuleClassification,
  extraReason?: string
): ClassificationResult {
  return {
    isJobRelated: rules.isLikelyJob,
    company: rules.companyGuess,
    role: rules.roleGuess,
    status: rules.status,
    appliedAt: rules.status === "applied" ? message.receivedAt : null,
    confidence: rules.confidence,
    reason: extraReason ? `${extraReason}; ${rules.reason}` : rules.reason,
    source: "rules",
  };
}

function reconcileStatus(
  llmStatus: JobStatus,
  rules: RuleClassification,
  haystack: string
): JobStatus {
  const hypotheticalInterview =
    /\b(if (you are )?selected for (an )?interview|may (include|involve) (an )?interview|interview process|we will (be in touch|contact you).{0,40}interview)\b/i.test(
      haystack
    );
  const realInterview =
    /\b(you('?re| are) invited to|invitation to|please (schedule|book)|scheduled|confirmed).{0,50}\b(interview|phone screen|onsite)\b/i.test(
      haystack
    );

  if (llmStatus === "interview" && hypotheticalInterview && !realInterview) {
    if (rules.status === "applied" || rules.status === "under_review") {
      return rules.status;
    }
    return "applied";
  }

  if (
    rules.status === "applied" &&
    rules.confidence !== "low" &&
    llmStatus === "interview" &&
    !realInterview
  ) {
    return "applied";
  }

  return llmStatus;
}

function stripJsonFence(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)```$/i);
  return fenced?.[1]?.trim() ?? trimmed;
}

function buildUserPayload(message: ParsedGmailMessage, rules: RuleClassification) {
  return JSON.stringify({
    from: message.fromAddress,
    subject: message.subject,
    date: message.receivedAt.toISOString(),
    snippet: message.snippet?.slice(0, 280) ?? "",
    bodyExcerpt: message.bodyExcerpt.slice(0, BODY_EXCERPT_CHARS),
    rulesHint: {
      status: rules.status,
      companyGuess: rules.companyGuess,
      roleGuess: rules.roleGuess,
    },
  });
}

function toResult(
  data: z.infer<typeof ExtractionSchema>,
  message: ParsedGmailMessage,
  rules: RuleClassification,
  haystack: string
): ClassificationResult {
  const company =
    (data.company && data.company.trim()) || rules.companyGuess || null;
  const role = (data.role && data.role.trim()) || rules.roleGuess || null;
  const status = reconcileStatus(data.status, rules, haystack);

  return {
    isJobRelated: data.isJobRelated,
    company: company && !/^unknown$/i.test(company) ? company : null,
    role,
    status,
    appliedAt:
      parseAppliedDate(data.appliedDate) ??
      (status === "applied" ? message.receivedAt : null),
    confidence: data.confidence,
    reason: data.reason,
    source: "hybrid",
  };
}

function resolveProvider(): "gemini" | "openai" | null {
  if (process.env.GEMINI_API_KEY?.trim()) return "gemini";
  if (process.env.OPENAI_API_KEY?.trim()) return "openai";
  return null;
}

function shouldCallLlm(rules: RuleClassification): boolean {
  if (rules.noiseKind !== "none") return false;
  return rules.isLikelyJob;
}

function isRateLimitError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  const status =
    (err as { status?: number; statusCode?: number; code?: number })?.status ??
    (err as { statusCode?: number })?.statusCode ??
    (err as { code?: number })?.code;
  return (
    status === 429 ||
    /too many requests|resource.exhausted|rate.?limit|quota/i.test(msg)
  );
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function throttleLlmCalls() {
  const wait = lastLlmCallAt + MIN_INTERVAL_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastLlmCallAt = Date.now();
}

async function withRetries<T>(fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      await throttleLlmCalls();
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isRateLimitError(err) || attempt === MAX_RETRIES - 1) throw err;
      // Free tier: back off hard (15s, 30s, …)
      const backoff = 15000 * (attempt + 1);
      console.warn(`LLM rate limited; retrying in ${backoff}ms`);
      await sleep(backoff);
      lastLlmCallAt = Date.now();
    }
  }
  throw lastErr;
}

async function classifyWithGemini(
  message: ParsedGmailMessage,
  rules: RuleClassification
): Promise<string> {
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
  const modelName = process.env.GEMINI_MODEL?.trim() || "gemini-2.0-flash";
  const model = genAI.getGenerativeModel({
    model: modelName,
    generationConfig: {
      temperature: 0,
      responseMimeType: "application/json",
      maxOutputTokens: 256,
    },
  });

  const result = await model.generateContent([
    { text: SYSTEM_PROMPT },
    { text: buildUserPayload(message, rules) },
  ]);

  return result.response.text();
}

async function classifyWithOpenAI(
  message: ParsedGmailMessage,
  rules: RuleClassification
): Promise<string> {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });
  const completion = await openai.chat.completions.create({
    model: process.env.OPENAI_MODEL?.trim() || "gpt-4o-mini",
    temperature: 0,
    max_tokens: 256,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: buildUserPayload(message, rules) },
    ],
  });
  return completion.choices[0]?.message?.content ?? "{}";
}

export async function classifyEmail(
  message: ParsedGmailMessage,
  rules: RuleClassification
): Promise<ClassificationResult> {
  if (!shouldCallLlm(rules)) {
    return fromRules(message, rules);
  }

  const provider = resolveProvider();
  if (!provider) {
    return fromRules(message, rules);
  }

  if (llmCallsThisSync >= MAX_CALLS_PER_SYNC) {
    budgetExhaustedFallbacks += 1;
    return fromRules(message, rules, "llm-budget-exhausted");
  }

  const haystack = `${message.subject}\n${message.snippet}\n${message.bodyExcerpt}`;

  try {
    llmCallsThisSync += 1;
    const rawText = await withRetries(async () =>
      provider === "gemini"
        ? classifyWithGemini(message, rules)
        : classifyWithOpenAI(message, rules)
    );

    const parsed = ExtractionSchema.safeParse(
      JSON.parse(stripJsonFence(rawText))
    );
    if (!parsed.success) {
      return fromRules(message, rules, `${provider}-parse-failed`);
    }
    return toResult(parsed.data, message, rules, haystack);
  } catch (err) {
    console.error(`${provider} classification failed`, err);
    if (isRateLimitError(err)) {
      rateLimitedFallbacks += 1;
      // Stop burning the free tier for the rest of this sync
      llmCallsThisSync = MAX_CALLS_PER_SYNC;
      return fromRules(message, rules, `${provider}-rate-limited`);
    }
    return fromRules(message, rules, `${provider}-error`);
  }
}

export function getActiveLlmProvider(): "gemini" | "openai" | "none" {
  return resolveProvider() ?? "none";
}
