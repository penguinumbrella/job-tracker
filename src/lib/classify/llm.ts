import OpenAI from "openai";
import { z } from "zod";
import type { ParsedGmailMessage } from "@/lib/gmail";
import type { RuleClassification } from "@/lib/classify/rules";
import { JOB_STATUSES, type JobStatus } from "@/lib/types";

const ExtractionSchema = z.object({
  isJobRelated: z.boolean(),
  company: z.string().nullable(),
  role: z.string().nullable(),
  status: z.enum(JOB_STATUSES),
  appliedDate: z.string().nullable(),
  confidence: z.enum(["high", "medium", "low"]),
  reason: z.string(),
});

export type LlmExtraction = z.infer<typeof ExtractionSchema>;

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

function parseAppliedDate(value: string | null, fallback: Date): Date | null {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

export async function classifyEmail(
  message: ParsedGmailMessage,
  rules: RuleClassification
): Promise<ClassificationResult> {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey || !rules.isLikelyJob) {
    return {
      isJobRelated: rules.isLikelyJob,
      company: rules.companyGuess,
      role: null,
      status: rules.status,
      appliedAt: rules.status === "applied" ? message.receivedAt : null,
      confidence: rules.confidence,
      reason: rules.reason,
      source: "rules",
    };
  }

  try {
    const openai = new OpenAI({ apiKey });
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `You classify inbox emails for a job application tracker.
Return JSON with keys: isJobRelated (boolean), company (string|null), role (string|null),
status (one of ${JOB_STATUSES.join("|")}), appliedDate (ISO date string|null if email confirms submission),
confidence (high|medium|low), reason (short string).
Only mark isJobRelated true if this email is clearly about the recipient's job application or hiring process.
Ignore newsletters, job board digests, marketing, and general networking unless they confirm an application status.`,
        },
        {
          role: "user",
          content: JSON.stringify({
            from: message.fromAddress,
            subject: message.subject,
            date: message.receivedAt.toISOString(),
            snippet: message.snippet,
            bodyExcerpt: message.bodyExcerpt.slice(0, 1800),
            rulesHint: rules,
          }),
        },
      ],
    });

    const raw = completion.choices[0]?.message?.content ?? "{}";
    const parsed = ExtractionSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      return {
        isJobRelated: rules.isLikelyJob,
        company: rules.companyGuess,
        role: null,
        status: rules.status,
        appliedAt: rules.status === "applied" ? message.receivedAt : null,
        confidence: "low",
        reason: `llm-parse-failed; ${rules.reason}`,
        source: "rules",
      };
    }

    const data = parsed.data;
    return {
      isJobRelated: data.isJobRelated,
      company: data.company ?? rules.companyGuess,
      role: data.role,
      status: data.status,
      appliedAt:
        parseAppliedDate(data.appliedDate, message.receivedAt) ??
        (data.status === "applied" ? message.receivedAt : null),
      confidence: data.confidence,
      reason: data.reason,
      source: "hybrid",
    };
  } catch (err) {
    console.error("LLM classification failed", err);
    return {
      isJobRelated: rules.isLikelyJob,
      company: rules.companyGuess,
      role: null,
      status: rules.status,
      appliedAt: rules.status === "applied" ? message.receivedAt : null,
      confidence: rules.confidence,
      reason: `llm-error; ${rules.reason}`,
      source: "rules",
    };
  }
}
