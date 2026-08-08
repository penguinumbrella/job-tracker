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

/** Guardrail: LLMs often mark "thank you for applying… interview process" as interview. */
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

  // Prefer strong rules evidence for applied confirmations
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

export async function classifyEmail(
  message: ParsedGmailMessage,
  rules: RuleClassification
): Promise<ClassificationResult> {
  if (rules.noiseKind !== "none") {
    return fromRules(message, rules);
  }

  const apiKey = process.env.OPENAI_API_KEY;
  const haystack = `${message.subject}\n${message.snippet}\n${message.bodyExcerpt}`;

  if (!apiKey) {
    return fromRules(message, rules);
  }

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

isJobRelated = true ONLY if the email is about an application the recipient already submitted, OR a later stage update for that same application (review, assessment invite, scheduled interview, offer, rejection, withdrawal).

isJobRelated = false for job alerts, digests, "new openings", apply-now bots, cold recruiter spam, newsletters.

STATUS RULES (important):
- applied: confirmation that they submitted / application was received. Even if the email mentions "interview process" or "if selected for an interview", status is still applied.
- under_review: explicitly reviewing their application now.
- assessment: they are asked to complete a test / Hackerrank / take-home NOW.
- interview: ONLY if an interview is invited, scheduled, or confirmed. Mere mention of the word "interview" is NOT enough.
- offer / rejected / withdrawn: clear outcome language.
- unknown: unclear stage.

FIELD EXTRACTION:
- company: employer name from body ("application at/to/with COMPANY") or From display name. Never "Unknown"; use null if unclear.
- role: the job title (e.g. "Software Engineer Intern", "Analyst"). Look in subject and body for "application for ROLE", "ROLE role/position", "Position: ROLE". null if absent.
- appliedDate: ISO date when this email confirms submission; else null.
- confidence: high|medium|low
- reason: short

Return JSON keys: isJobRelated, company, role, status, appliedDate, confidence, reason.`,
        },
        {
          role: "user",
          content: JSON.stringify({
            from: message.fromAddress,
            subject: message.subject,
            date: message.receivedAt.toISOString(),
            snippet: message.snippet,
            bodyExcerpt: message.bodyExcerpt.slice(0, 3500),
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
    const role =
      (data.role && data.role.trim()) || rules.roleGuess || null;
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
  } catch (err) {
    console.error("LLM classification failed", err);
    return fromRules(message, rules, "llm-error");
  }
}
