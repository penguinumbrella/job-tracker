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
  "ultipro.com",
  "ukg.com",
  "dayforcehcm.com",
  "oraclecloud.com",
];

/** Senders / products that usually mean job *alerts*, not your applications. */
const ALERT_NOISE_RE =
  /\b(job alert|jobs? for you|recommended jobs?|new openings?|new positions?|positions? matching|jobs? matching your|daily jobs?|weekly jobs?|job digest|hiring alert|people are hiring|companies are hiring|apply now to|start your application|complete your profile|saved search|indeed\.com|linkedin job|glassdoor|handshake|ziprecruiter|simplyhired|monster\.com|otta\.com|wellfound|angellist)\b/i;

const APPLY_BOT_NOISE_RE =
  /\b(application bot|auto[- ]?apply|easy apply reminder|don'?t forget to apply|finish applying|continue your application|jobs? you may like|based on your (search|preferences))\b/i;

/** Mentions of interviews that are NOT actual interview invites. */
const INTERVIEW_HYPOTHETICAL_RE =
  /\b(if (you are )?selected for (an )?interview|may (include|involve) (an )?interview|possible interview|interview process|throughout the (hiring|interview)|next steps may|we will (be in touch|contact you).{0,40}interview|candidates (selected|chosen) for interview)\b/i;

/** Strong evidence this email is about *your* submitted application / hiring stage. */
const APPLIED_EVIDENCE: { re: RegExp; status: JobStatus; weight: number }[] = [
  {
    re: /thank you for (your )?appl(y|ication)|thanks for appl(y|ying)|we (have )?received your application|your application (has been |was )?(successfully )?(received|submitted)|successfully (submitted|applied)|congrats.{0,60}submitted|application (confirmation|received)|we('?re| are) confirming (receipt of )?your application|your (job )?application was (received|submitted)/i,
    status: "applied",
    weight: 6,
  },
  {
    re: /your application (is |has been )?under review|we('?re| are) reviewing your application|application (is )?being reviewed|currently reviewing your/i,
    status: "under_review",
    weight: 5,
  },
  {
    re: /\b(please (complete|take)|you('?ve| have) been invited to|complete your).{0,40}\b(online assessment|hackerrank|codility|take[- ]home (assignment|project)|coding challenge|skills? (test|assessment))\b|\b(online assessment|hackerrank|codility|take[- ]home).{0,30}\b(invite|invitation|complete|due)\b/i,
    status: "assessment",
    weight: 5,
  },
  {
    // Only real invites / scheduled interviews — not the word "interview" alone
    re: /\b(you('?re| are) invited to|invitation to|invite you to|please (schedule|book)|scheduled (an? |your )?|confirmed).{0,50}\b(interview|phone screen|onsite|video call)\b|\b(interview|phone screen|onsite).{0,40}\b(has been scheduled|is scheduled|invite|invitation|confirmed for)\b/i,
    status: "interview",
    weight: 6,
  },
  {
    re: /\b(offer of employment|pleased to (extend|offer)|official offer|job offer|offer letter)\b/i,
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
  /(?:application|applying) (?:for|to) .{1,80}? (?:at|with|@)\s+([A-Z][^.\n!?]{1,60})/i,
];

const ROLE_FROM_BODY: RegExp[] = [
  // "application for Software Engineer Intern at JPMorgan"
  /application for (?:the )?(?:role of |position of )?["']?([A-Za-z0-9][^.\n"']{2,90}?)["']?\s+(?:at|with|@)\b/i,
  // "for the Software Engineer role" / "for Software Engineer Intern role"
  /(?:for the |for )["']?([A-Za-z0-9][^.\n"']{2,70}?)["']?\s+(?:role|position|opening|requisition)\b/i,
  // "Position: Backend Engineer" / "Role - Data Analyst"
  /(?:role|position|job title|requisition|job)\s*[:\-–]\s*([A-Za-z0-9][^\n]{2,80})/i,
  // "as a Software Engineer Intern"
  /\bas (?:a|an)\s+([A-Za-z][^.\n]{2,70}?)\s+(?:at|with|@)\b/i,
  // "applying to the X position"
  /applying to (?:the )?["']?([A-Za-z0-9][^.\n"']{2,70}?)["']?\s+(?:role|position|opening)\b/i,
  // subject-style: "Your application for Product Manager"
  /your application for (?:the )?["']?([A-Za-z0-9][^.\n"']{2,70}?)["']?(?:\s+at\b|\s*$)/i,
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
    // Stop before role clauses glued onto company captures
    .replace(/\s+for (the )?(role|position|opening)\b.*$/i, "")
    .replace(/\s+for the\s+.+$/i, "")
    .replace(/\b(inc|llc|ltd|corp|corporation|company|co)\b\.?/gi, "")
    .replace(/\b(recruiting|recruitment|talent|hiring|careers|team|noreply|no-reply|via .*)$/i, "")
    .replace(/[|–—:].*$/, "")
    .trim();

  name = name.replace(/[!?,;]+$/g, "").trim();

  if (name.length < 2 || name.length > 60) return null;
  if (/^(your|our|the|this|that|unknown|company|here)$/i.test(name)) return null;
  if (ATS_DOMAIN_HINTS.some((d) => name.toLowerCase().includes(d.split(".")[0]))) {
    return null;
  }
  return name;
}

function cleanRoleCandidate(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let role = raw
    .replace(/\s+/g, " ")
    .replace(/["'”’]+/g, "")
    .replace(/^(the|a|an)\s+/i, "")
    .replace(/\s+(at|with|@|for)\s+.*$/i, "")
    .replace(/[!?,;:.]+$/g, "")
    .trim();

  if (role.length < 3 || role.length > 80) return null;
  if (
    /^(role|position|job|application|opportunity|opening|requisition|team|company)$/i.test(
      role
    )
  ) {
    return null;
  }
  // Avoid swallowing whole sentences
  if (role.split(" ").length > 12) return null;
  return role;
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
    const cleaned = cleanRoleCandidate(m?.[1]);
    if (cleaned) return cleaned;
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
    if (!pattern.re.test(haystack)) continue;
    // Don't treat hypothetical "interview process" language as an interview invite
    if (
      pattern.status === "interview" &&
      INTERVIEW_HYPOTHETICAL_RE.test(haystack) &&
      !/\b(scheduled|invitation to interview|invited to (an )?interview|interview confirmed)\b/i.test(
        haystack
      )
    ) {
      reasons.push("interview-mentioned-but-hypothetical");
      continue;
    }
    if (pattern.weight > bestWeight) {
      bestStatus = pattern.status;
      bestWeight = pattern.weight;
      reasons.push(`evidence:${pattern.status}`);
    }
  }

  // Confirmation emails that mention interviews in the future stay "applied"
  if (
    bestStatus === "interview" &&
    INTERVIEW_HYPOTHETICAL_RE.test(haystack) &&
    /thank you for (your )?appl|we (have )?received your application|application (received|submitted)/i.test(
      haystack
    )
  ) {
    bestStatus = "applied";
    bestWeight = 6;
    reasons.push("downgraded-interview-to-applied");
  }

  const companyGuess =
    guessCompanyFromBody(haystack) ?? guessCompanyFromFrom(message.fromAddress);
  const roleGuess =
    guessRoleFromBody(haystack) ??
    guessRoleFromBody(message.subject) ??
    null;

  if (companyGuess) reasons.push("company-extracted");
  if (roleGuess) reasons.push("role-extracted");
  if (atsHit) reasons.push("ats-sender");

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
