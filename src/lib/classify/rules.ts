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

const SUBJECT_PATTERNS: { re: RegExp; status: JobStatus; weight: number }[] = [
  {
    re: /thank you for (your )?appl(y|ication)|application (has been )?received|we received your application|successfully (submitted|applied)|congrats.{0,40}submitted/i,
    status: "applied",
    weight: 5,
  },
  {
    re: /application (is )?under review|we('re| are) reviewing your/i,
    status: "under_review",
    weight: 4,
  },
  {
    re: /\b(assessment|hackerrank|codility|take[- ]home|online test|coding challenge)\b/i,
    status: "assessment",
    weight: 4,
  },
  {
    re: /\b(interview|phone screen|onsite|next steps|schedule a call)\b/i,
    status: "interview",
    weight: 4,
  },
  {
    re: /\b(offer|congratulations.{0,30}(role|position|team))\b/i,
    status: "offer",
    weight: 5,
  },
  {
    re: /\b(unfortunately|not moving forward|other candidates|will not be progressing|rejected)\b/i,
    status: "rejected",
    weight: 5,
  },
  {
    re: /\b(withdrawn|withdrawal of your application)\b/i,
    status: "withdrawn",
    weight: 4,
  },
];

const JOB_KEYWORD_RE =
  /\b(application|applicant|candidacy|interview|hiring|recruiter|role|position|internship|job)\b/i;

export type RuleClassification = {
  isLikelyJob: boolean;
  status: JobStatus;
  confidence: "high" | "medium" | "low";
  reason: string;
  companyGuess: string | null;
};

function extractEmailDomain(fromAddress: string): string {
  const match = fromAddress.match(/@([a-z0-9.-]+)/i);
  return match?.[1]?.toLowerCase() ?? "";
}

function guessCompanyFromFrom(fromAddress: string): string | null {
  const nameMatch = fromAddress.match(/^"?([^"<]+)"?\s*</);
  if (nameMatch?.[1]) {
    const name = nameMatch[1]
      .replace(/\b(recruiting|recruitment|talent|hiring|careers|team|noreply|no-reply)\b/gi, "")
      .replace(/[-_|]+/g, " ")
      .trim();
    if (name.length > 1 && name.length < 60) return name;
  }

  const domain = extractEmailDomain(fromAddress)
    .replace(/^(mail|email|careers|jobs|noreply|no-reply|notifications?)\./, "")
    .split(".")[0];

  if (!domain || ATS_DOMAIN_HINTS.some((d) => domain.includes(d.split(".")[0]))) {
    return null;
  }

  return domain.charAt(0).toUpperCase() + domain.slice(1);
}

export function classifyWithRules(message: ParsedGmailMessage): RuleClassification {
  const domain = extractEmailDomain(message.fromAddress);
  const haystack = `${message.subject}\n${message.snippet}\n${message.bodyExcerpt}`;
  const atsHit = ATS_DOMAIN_HINTS.some(
    (d) => domain.includes(d) || message.fromAddress.toLowerCase().includes(d)
  );
  const keywordHit = JOB_KEYWORD_RE.test(haystack);

  let bestStatus: JobStatus = "unknown";
  let bestWeight = 0;
  const reasons: string[] = [];

  for (const pattern of SUBJECT_PATTERNS) {
    if (pattern.re.test(haystack) && pattern.weight > bestWeight) {
      bestStatus = pattern.status;
      bestWeight = pattern.weight;
      reasons.push(`pattern:${pattern.status}`);
    }
  }

  if (atsHit) reasons.push("ats-sender");
  if (keywordHit) reasons.push("job-keywords");

  const isLikelyJob =
    atsHit || bestWeight >= 4 || (keywordHit && bestWeight >= 3) || (keywordHit && atsHit);

  let confidence: "high" | "medium" | "low" = "low";
  if (atsHit && bestWeight >= 4) confidence = "high";
  else if (bestWeight >= 4 || (atsHit && keywordHit)) confidence = "medium";

  return {
    isLikelyJob,
    status: bestStatus,
    confidence,
    reason: reasons.join(", ") || "no-strong-signal",
    companyGuess: guessCompanyFromFrom(message.fromAddress),
  };
}
