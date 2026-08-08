import { GoogleGenerativeAI } from "@google/generative-ai";
import OpenAI from "openai";
import { z } from "zod";
import type { ParsedGmailMessage } from "@/lib/gmail";
import type { RuleClassification } from "@/lib/classify/rules";
import { JOB_STATUSES, type JobStatus } from "@/lib/types";

/** Per-email body cap inside a batch (keep batches under TPM limits). */
const BODY_EXCERPT_CHARS = 900;

/**
 * Batch ~10 emails per API call to stretch free-tier RPM.
 * Override with LLM_BATCH_SIZE / LLM_MIN_INTERVAL_MS / LLM_MAX_CALLS_PER_SYNC.
 */
export const LLM_BATCH_SIZE = Number(process.env.LLM_BATCH_SIZE ?? 10);
const MIN_INTERVAL_MS = Number(process.env.LLM_MIN_INTERVAL_MS ?? 4500);
/** Max API calls (batches) per sync — 5×10 emails ≈ 50 LLM-enriched messages. */
const MAX_CALLS_PER_SYNC = Number(process.env.LLM_MAX_CALLS_PER_SYNC ?? 5);
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

const BatchItemSchema = ExtractionSchema.extend({
  id: z.string(),
});

const BatchResponseSchema = z.object({
  results: z.array(BatchItemSchema),
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

export type LlmCandidate = {
  message: ParsedGmailMessage;
  rules: RuleClassification;
};

export type LlmSyncStats = {
  calls: number;
  rateLimitedFallbacks: number;
  budgetExhaustedFallbacks: number;
  batchSize: number;
};

let lastLlmCallAt = 0;
let llmCallsThisSync = 0;
let rateLimitedFallbacks = 0;
let budgetExhaustedFallbacks = 0;

export function resetLlmBudget() {
  llmCallsThisSync = 0;
  rateLimitedFallbacks = 0;
  budgetExhaustedFallbacks = 0;
}

export function getLlmSyncStats(): LlmSyncStats {
  return {
    calls: llmCallsThisSync,
    rateLimitedFallbacks,
    budgetExhaustedFallbacks,
    batchSize: LLM_BATCH_SIZE,
  };
}

const BATCH_SYSTEM_PROMPT = `You classify inbox emails for a personal job APPLICATION tracker.
You will receive a JSON array of emails. Reply with JSON only:
{ "results": [ { "id": "<same id>", "isJobRelated": bool, "company": string|null, "role": string|null, "status": "...", "appliedDate": string|null, "confidence": "high|medium|low", "reason": "..." } ] }

Return exactly one result object per input email, using the same id.

isJobRelated=true only if the recipient already applied, or this is a later stage update (review/assessment invite/scheduled interview/offer/rejection/withdrawal).
isJobRelated=false for alerts, digests, new openings, apply-bots, cold outreach, newsletters.

status:
- applied: submission/received confirmation (even if it mentions a future "interview process")
- under_review: actively reviewing their application
- assessment: they must take a test/Hackerrank/take-home now
- interview: ONLY invited/scheduled/confirmed interview — not the word "interview" alone
- offer|rejected|withdrawn|unknown

company: never "Unknown"; null if unclear. role: job title or null.
status must be one of: ${JOB_STATUSES.join("|")}`;

function parseAppliedDate(value: string | null): Date | null {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

export function fromRules(
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

function buildBatchPayload(candidates: LlmCandidate[]) {
  return JSON.stringify({
    emails: candidates.map(({ message, rules }) => ({
      id: message.gmailMessageId,
      from: message.fromAddress,
      subject: message.subject,
      date: message.receivedAt.toISOString(),
      snippet: message.snippet?.slice(0, 200) ?? "",
      bodyExcerpt: message.bodyExcerpt.slice(0, BODY_EXCERPT_CHARS),
      rulesHint: {
        status: rules.status,
        companyGuess: rules.companyGuess,
        roleGuess: rules.roleGuess,
      },
    })),
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

export function needsLlm(rules: RuleClassification): boolean {
  if (rules.noiseKind !== "none") return false;
  if (!resolveProvider()) return false;
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
      const backoff = 15000 * (attempt + 1);
      console.warn(`LLM rate limited; retrying in ${backoff}ms`);
      await sleep(backoff);
      lastLlmCallAt = Date.now();
    }
  }
  throw lastErr;
}

async function generateBatchRaw(
  provider: "gemini" | "openai",
  candidates: LlmCandidate[]
): Promise<string> {
  const userContent = buildBatchPayload(candidates);
  // ~80 tokens per result item
  const maxOut = Math.min(2048, 120 + candidates.length * 100);

  if (provider === "gemini") {
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
    const modelName = process.env.GEMINI_MODEL?.trim() || "gemini-2.0-flash";
    const model = genAI.getGenerativeModel({
      model: modelName,
      generationConfig: {
        temperature: 0,
        responseMimeType: "application/json",
        maxOutputTokens: maxOut,
      },
    });
    const result = await model.generateContent([
      { text: BATCH_SYSTEM_PROMPT },
      { text: userContent },
    ]);
    return result.response.text();
  }

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });
  const completion = await openai.chat.completions.create({
    model: process.env.OPENAI_MODEL?.trim() || "gpt-4o-mini",
    temperature: 0,
    max_tokens: maxOut,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: BATCH_SYSTEM_PROMPT },
      { role: "user", content: userContent },
    ],
  });
  return completion.choices[0]?.message?.content ?? "{}";
}

function parseBatchResponse(
  rawText: string,
  candidates: LlmCandidate[],
  provider: string
): ClassificationResult[] {
  const parsed = BatchResponseSchema.safeParse(
    JSON.parse(stripJsonFence(rawText))
  );

  const byId = new Map<string, z.infer<typeof BatchItemSchema>>();
  if (parsed.success) {
    for (const item of parsed.data.results) {
      byId.set(item.id, item);
    }
  }

  return candidates.map(({ message, rules }) => {
    const item = byId.get(message.gmailMessageId);
    if (!item) {
      return fromRules(message, rules, `${provider}-batch-missing-id`);
    }
    const haystack = `${message.subject}\n${message.snippet}\n${message.bodyExcerpt}`;
    return toResult(item, message, rules, haystack);
  });
}

/**
 * Classify a batch of rule-matched emails in a single LLM API call.
 * Falls back to rules for the whole batch on budget/rate-limit/parse failure.
 */
export async function classifyEmailBatch(
  candidates: LlmCandidate[]
): Promise<ClassificationResult[]> {
  if (candidates.length === 0) return [];

  const provider = resolveProvider();
  if (!provider) {
    return candidates.map(({ message, rules }) => fromRules(message, rules));
  }

  if (llmCallsThisSync >= MAX_CALLS_PER_SYNC) {
    budgetExhaustedFallbacks += candidates.length;
    return candidates.map(({ message, rules }) =>
      fromRules(message, rules, "llm-budget-exhausted")
    );
  }

  try {
    llmCallsThisSync += 1;
    const rawText = await withRetries(() =>
      generateBatchRaw(provider, candidates)
    );
    return parseBatchResponse(rawText, candidates, provider);
  } catch (err) {
    console.error(`${provider} batch classification failed`, err);
    if (isRateLimitError(err)) {
      rateLimitedFallbacks += 1;
      llmCallsThisSync = MAX_CALLS_PER_SYNC;
      return candidates.map(({ message, rules }) =>
        fromRules(message, rules, `${provider}-rate-limited`)
      );
    }
    return candidates.map(({ message, rules }) =>
      fromRules(message, rules, `${provider}-batch-error`)
    );
  }
}

/** Convenience for a single email (wraps batch of 1). */
export async function classifyEmail(
  message: ParsedGmailMessage,
  rules: RuleClassification
): Promise<ClassificationResult> {
  if (!needsLlm(rules)) {
    return fromRules(message, rules);
  }
  const [result] = await classifyEmailBatch([{ message, rules }]);
  return result;
}

export function getActiveLlmProvider(): "gemini" | "openai" | "none" {
  return resolveProvider() ?? "none";
}
