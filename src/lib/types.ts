export const JOB_STATUSES = [
  "applied",
  "under_review",
  "assessment",
  "interview",
  "offer",
  "rejected",
  "withdrawn",
  "unknown",
] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];

export const STATUS_LABELS: Record<JobStatus, string> = {
  applied: "Applied",
  under_review: "Under review",
  assessment: "Assessment",
  interview: "Interview",
  offer: "Offer",
  rejected: "Rejected",
  withdrawn: "Withdrawn",
  unknown: "Unknown",
};

export function isJobStatus(value: string): value is JobStatus {
  return (JOB_STATUSES as readonly string[]).includes(value);
}

export function gmailMessageLink(messageId: string): string {
  return `https://mail.google.com/mail/u/0/#all/${messageId}`;
}
