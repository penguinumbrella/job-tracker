import assert from "node:assert/strict";
import { classifyWithRules } from "../src/lib/classify/rules";
import type { ParsedGmailMessage } from "../src/lib/gmail";

function msg(partial: Partial<ParsedGmailMessage>): ParsedGmailMessage {
  return {
    gmailMessageId: "x",
    gmailThreadId: "t",
    receivedAt: new Date("2026-03-01"),
    fromAddress: 'Careers <noreply@example.com>',
    subject: "Hello",
    snippet: "",
    bodyExcerpt: "",
    gmailLink: "https://mail.google.com/mail/u/0/#all/x",
    ...partial,
  };
}

// Real application confirmation → keep + extract company from body
{
  const r = classifyWithRules(
    msg({
      fromAddress: "JPMorgan Chase Recruiting <no-reply@jpmorganchase.com>",
      subject: "Thank you for applying",
      bodyExcerpt:
        "Congrats! We have received your application at JPMorgan Chase for the Software Engineer Intern role.",
    })
  );
  assert.equal(r.isLikelyJob, true);
  assert.equal(r.status, "applied");
  assert.match(r.companyGuess ?? "", /JPMorgan/i);
}

// Job alert / new opening → reject
{
  const r = classifyWithRules(
    msg({
      fromAddress: "Indeed <noreply@indeed.com>",
      subject: "12 new openings matching Software Engineer",
      bodyExcerpt:
        "Companies are hiring near you. Apply now to these recommended jobs.",
    })
  );
  assert.equal(r.isLikelyJob, false);
  assert.equal(r.noiseKind, "alert");
}

// Apply bot reminder → reject
{
  const r = classifyWithRules(
    msg({
      subject: "Don't forget to finish applying",
      bodyExcerpt: "Your easy apply reminder — continue your application today.",
    })
  );
  assert.equal(r.isLikelyJob, false);
  assert.equal(r.noiseKind, "bot");
}

// ATS alone without application evidence → reject
{
  const r = classifyWithRules(
    msg({
      fromAddress: "Jobs <jobs@greenhouse.io>",
      subject: "New roles at Acme",
      bodyExcerpt: "Check out new positions on our board.",
    })
  );
  assert.equal(r.isLikelyJob, false);
}

console.log("classify rules tests passed");
