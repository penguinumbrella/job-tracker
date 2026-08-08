/**
 * Classification rules: only treat mail as a tracked application when there is
 * evidence the recipient actually applied (or progressed in that pipeline).
 * Job alerts, "new opening" digests, and apply-bots are rejected.
 */
import type { ParsedGmailMessage } from "@/lib/gmail";
import type { JobStatus } from "@/lib/types";

const ATS_DOMAIN_HINTS = [
  "greenhouse.io",
  "lever.co",
  "myworkday.com",
  "ashbyhq.com",
  "workable.com",
  "icims.com",
  "successfactors.com",
  "smartrecruiters.com",
  "jobvite.com",
  "taleo.net",
  "brassring.com",
  "recruiting.adp.com",
  "hire.lever.co",
  "boards.greenhouse.io",
  "apply.workable.com",
];

/** Senders / products that usually mean job *alerts*, not your applications. */
const ALERT_NOISE_RE =
  /\b(job alert|jobs? for you|recommended jobs?|new openings?|new positions?|positions? matching|jobs? matching your|daily jobs?|weekly jobs?|job digest|hiring alert|people are hiring|companies are hiring|apply now to|start your application|complete your profile|saved search|indeed\.com|linkedin job|glassdoor|handshake|ziprecruiter|simplyhired|monster\.com|otta\.com|wellfound|angellist)\b/i;

const APPLY_BOT_NOISE_RE =
  /\b(application bot|auto[- ]?apply|easy apply reminder|don'?t forget to apply|finish applying|continue your application|jobs? you may like|based on your (search|preferences))\b/i;

/** Strong evidence this email is about *your* submitted application / hiring stage. */
const APPLIED_EVIDENCE: { re: RegExp; status: JobStatus; weight: number }[] = [
  {
    re: /thank you for (your )?appl(y|ication)|thanks for appl(y|ying)|we (have )?received your application|your application (has been |was )?(successfully )?(received|submitted)|successfully (submitted|applied)|congrats.{0,60}submitted|application (confirmation|received)|we('?re| are) confirming (receipt of )?your application/i,
    status: "applied",
    weight: 6,
  },
  {
    re: /your application (is |has been )?under review|we('?re| are) reviewing your application|application (is )?being reviewed/i,
    status: "under_review",
    weight: 5,
  },
  {
    re: /\b(online assessment|hackerrank|codility|take[- ]home (assignment|project)|coding challenge|skills? (test|assessment))\b.{0,40}\b(application|candidacy|role|position)?/i,
    status: "assessment",
    weight: 4,
  },
  {
    re: /\b(invite|invited|schedule|scheduled).{0,40}\b(interview|phone screen|onsite)\b|\b(interview|phone screen).{0,40}\b(invite|invitation|scheduled|with us)\b/i,
    status: "interview",
    weight: 5,
  },
  {
    re: /\b(offer of employment|pleased to (extend|offer)|official offer|job offer)\b/i,
    status: "offer",
    weight: 6,
  },
  {
    re: /\b(unfortunately|not moving forward|other candidates|will not be progressing|decided not to (move|advance)|we regret to inform).{0,80}\b(application|candidacy|role|position)?/i,
    status: "rejected",
    weight: 5,
  },
  {
    re: /\b(withdrawn|withdrawal of your application|you withdrew)\b/i,
    status: "withdrawn",
    weight: 4,
  },
];

const COMPANY_FROM_BODY: RegExp[] = [
  /(?:we (?:have )?received|thank(?:s| you) for) your application (?:to|at|for|with)\s+([A-Z][^.\n!?]{1,80})/i,
  /your application (?:to|at|for|with)\s+([A-Z][^.\n!?]{1,80})/i,
  /application (?:for .{1,60} )?(?:at|with)\s+([A-Z][^.\n!?]{1,80})/i,
  /thank you for applying (?:to|at|for|with)\s+([A-Z][^.\n!?]{1,80})/i,
  /(?:applied|application submitted) (?:to|at|for|with)\s+([A-Z][^.\n!?]{1,80})/i,
  /(?:position|role|opportunity) at\s+([A-Z][^.\n!?]{1,60})/i,
  /(?:interview|assessment) (?:with|at)\s+([A-Z][^.\n!?]{1,60})/i,
  /(?:regarding|about) your application (?:to|at|for|with)\s+([A-Z][^.\n!?]{1,80})/i,
];

const ROLE_FROM_BODY: RegExp[] = [
  /application (?:for|to) (?:the )?(?:role|position|job)?\s*["']?([A-Za-z0-9][^.\n"']{2,80}?)["']?(?:\s+at\s+)/i,
  /(?:role|position|job title)\s*[:\-–]\s*([A-Za-z0-9][^\n]{2,80})/i,
  /(?:for the|as (?:a|an)|the)\s+([A-Za-z][^.\n]{2,60}?)\s+(?:role|position|opening)/i,
];

export type RuleClassification = {
  /** True only if this looks like the user's actual application pipeline email. */
  isLikelyJob: boolean;
  status: JobStatus;
  confidence: "high" | "medium" | "low";
  reason: string;
  companyGuess: string | null;
  roleGuess: string | null;
  noiseKind: "alert" | "bot" | "none";
};

function extractEmailDomain(fromAddress: string): string {
  const match = fromAddress.match(/@([a-z0-9.-]+)/i);
  return match?.[1]?.toLowerCase() ?? "";
}

function cleanCompanyCandidate(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let name = raw
    .replace(/\s+/g, " ")
    .replace(/["'”’]+/g, "")
    .replace(/\b(inc|llc|ltd|corp|corporation|company|co)\b\.?/gi, "")
    .replace(/\b(recruiting|recruitment|talent|hiring|careers|team|noreply|no-reply|via .*)$/i, "")
    .replace(/[|–—:].*$/, "")
    .trim();

  // Drop trailing fragments like "!" leftover from templates
  name = name.replace(/[!?,;]+$/g, "").trim();

  if (name.length < 2 || name.length > 60) return null;
  if (/^(your|our|the|this|that|unknown|company|here)$/i.test(name)) return null;
  if (ATS_DOMAIN_HINTS.some((d) => name.toLowerCase().includes(d.split(".")[0]))) {
    return null;
  }
  return name;
}

function guessCompanyFromBody(text: string): string | null {
  for (const re of COMPANY_FROM_BODY) {
    const m = text.match(re);
    const cleaned = cleanCompanyCandidate(m?.[1]);
    if (cleaned) return cleaned;
  }
  return null;
}

function guessRoleFromBody(text: string): string | null {
  for (const re of ROLE_FROM_BODY) {
    const m = text.match(re);
    if (!m?.[1]) continue;
    const role = m[1].replace(/\s+/g, " ").trim();
    if (role.length >= 3 && role.length <= 80) return role;
  }
  return null;
}

function guessCompanyFromFrom(fromAddress: string): string | null {
  const nameMatch = fromAddress.match(/^"?([^"<]+)"?\s*</);
  if (nameMatch?.[1]) {
    const cleaned = cleanCompanyCandidate(
      nameMatch[1]
        .replace(/\b(recruiting|recruitment|talent acquisition|talent|hiring|careers|team|noreply|no-reply|notifications?)\b/gi, " ")
        .replace(/[-_|]+/g, " ")
    );
    if (cleaned) return cleaned;
  }

  const domain = extractEmailDomain(fromAddress)
    .replace(/^(mail|email|careers|jobs|noreply|no-reply|notifications?|apply|talent)\./, "")
    .split(".")[0];

  if (!domain || ATS_DOMAIN_HINTS.some((d) => domain.includes(d.split(".")[0]))) {
    return null;
  }
  if (["gmail", "yahoo", "outlook", "hotmail", "googlemail"].includes(domain)) {
    return null;
  }

  return domain.charAt(0).toUpperCase() + domain.slice(1);
}

export function classifyWithRules(message: ParsedGmailMessage): RuleClassification {
  const domain = extractEmailDomain(message.fromAddress);
  const haystack = `${message.subject}\n${message.snippet}\n${message.bodyExcerpt}`;

  if (ALERT_NOISE_RE.test(haystack) || ALERT_NOISE_RE.test(message.fromAddress)) {
    return {
      isLikelyJob: false,
      status: "unknown",
      confidence: "high",
      reason: "noise:job-alert-or-opening-notification",
      companyGuess: null,
      roleGuess: null,
      noiseKind: "alert",
    };
  }

  if (APPLY_BOT_NOISE_RE.test(haystack)) {
    return {
      isLikelyJob: false,
      status: "unknown",
      confidence: "high",
      reason: "noise:apply-bot-or-reminder",
      companyGuess: null,
      roleGuess: null,
      noiseKind: "bot",
    };
  }

  const atsHit = ATS_DOMAIN_HINTS.some(
    (d) => domain.includes(d) || message.fromAddress.toLowerCase().includes(d)
  );

  let bestStatus: JobStatus = "unknown";
  let bestWeight = 0;
  const reasons: string[] = [];

  for (const pattern of APPLIED_EVIDENCE) {
    if (pattern.re.test(haystack) && pattern.weight > bestWeight) {
      bestStatus = pattern.status;
      bestWeight = pattern.weight;
      reasons.push(`evidence:${pattern.status}`);
    }
  }

  const companyGuess =
    guessCompanyFromBody(haystack) ?? guessCompanyFromFrom(message.fromAddress);
  const roleGuess = guessRoleFromBody(haystack);

  if (companyGuess) reasons.push("company-extracted");
  if (atsHit) reasons.push("ats-sender");

  // Require real application-pipeline evidence — ATS alone is not enough
  // (Greenhouse etc. also send marketing / job board mail).
  const isLikelyJob = bestWeight >= 4;

  let confidence: "high" | "medium" | "low" = "low";
  if (isLikelyJob && companyGuess && bestWeight >= 5) confidence = "high";
  else if (isLikelyJob && (companyGuess || atsHit)) confidence = "medium";
  else if (isLikelyJob) confidence = "low";

  return {
    isLikelyJob,
    status: bestStatus,
    confidence,
    reason: reasons.join(", ") || "no-application-evidence",
    companyGuess,
    roleGuess,
    noiseKind: "none",
  };
}
