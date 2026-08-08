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

export async function classifyEmail(
  message: ParsedGmailMessage,
  rules: RuleClassification
): Promise<ClassificationResult> {
  // Hard-reject alerts / bots without spending LLM tokens
  if (rules.noiseKind !== "none") {
    return fromRules(message, rules);
  }

  const apiKey = process.env.OPENAI_API_KEY;

  // No LLM: only keep emails with strong application evidence from rules
  if (!apiKey) {
    return fromRules(message, rules);
  }

  // Skip LLM when rules already know it's noise or clearly not an application
  if (!rules.isLikelyJob && rules.confidence === "high") {
    return fromRules(message, rules);
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
          content: `You classify inbox emails for a personal job APPLICATION tracker.

isJobRelated must be TRUE only when the email is about an application the recipient already submitted, or a later hiring-stage update for that application (review, assessment, interview, offer, rejection, withdrawal).

isJobRelated must be FALSE for:
- Job alerts / digests / "new positions hiring" / recommended jobs
- "Apply now" marketing or application bots / reminders to finish applying
- Recruiter cold outreach that does not reference an existing application
- Newsletters, networking, events

When isJobRelated is true, extract:
- company: the employer name. Prefer phrases in the body like "we received your application at/to/for/with COMPANY", "thank you for applying to COMPANY". Fall back to a clear display name in From. Never invent "Unknown". Use null if truly unclear.
- role: job title if present, else null
- status: one of ${JOB_STATUSES.join("|")}
- appliedDate: ISO date if the email confirms submission, else null
- confidence: high|medium|low
- reason: short explanation

Return JSON only with keys: isJobRelated, company, role, status, appliedDate, confidence, reason.`,
        },
        {
          role: "user",
          content: JSON.stringify({
            from: message.fromAddress,
            subject: message.subject,
            date: message.receivedAt.toISOString(),
            snippet: message.snippet,
            bodyExcerpt: message.bodyExcerpt.slice(0, 2200),
            rulesHint: {
              isLikelyJob: rules.isLikelyJob,
              status: rules.status,
              companyGuess: rules.companyGuess,
              roleGuess: rules.roleGuess,
              reason: rules.reason,
            },
          }),
        },
      ],
    });

    const raw = completion.choices[0]?.message?.content ?? "{}";
    const parsed = ExtractionSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      return fromRules(message, rules, "llm-parse-failed");
    }

    const data = parsed.data;
    const company =
      (data.company && data.company.trim()) ||
      rules.companyGuess ||
      null;
    const role = (data.role && data.role.trim()) || rules.roleGuess || null;

    return {
      isJobRelated: data.isJobRelated,
      company: company && !/^unknown$/i.test(company) ? company : null,
      role,
      status: data.status,
      appliedAt:
        parseAppliedDate(data.appliedDate) ??
        (data.status === "applied" ? message.receivedAt : null),
      confidence: data.confidence,
      reason: data.reason,
      source: "hybrid",
    };
  } catch (err) {
    console.error("LLM classification failed", err);
    return fromRules(message, rules, "llm-error");
  }
}
