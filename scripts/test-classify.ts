import assert from "node:assert/strict";
import { classifyWithRules } from "../src/lib/classify/rules";
import type { ParsedGmailMessage } from "../src/lib/gmail";

function msg(partial: Partial<ParsedGmailMessage>): ParsedGmailMessage {
  return {
    gmailMessageId: "x",
    gmailThreadId: "t",
    receivedAt: new Date("2026-03-01"),
    fromAddress: "Careers <noreply@example.com>",
    subject: "Hello",
    snippet: "",
    bodyExcerpt: "",
    gmailLink: "https://mail.google.com/mail/u/0/#all/x",
    ...partial,
  };
}

// Real application confirmation → company + role + applied (not interview)
{
  const r = classifyWithRules(
    msg({
      fromAddress: "JPMorgan Chase Recruiting <no-reply@jpmorganchase.com>",
      subject: "Thank you for applying",
      bodyExcerpt:
        "Congrats! We have received your application at JPMorgan Chase for the Software Engineer Intern role. If you are selected for an interview, we will be in touch.",
    })
  );
  assert.equal(r.isLikelyJob, true);
  assert.equal(r.status, "applied");
  assert.match(r.companyGuess ?? "", /JPMorgan/i);
  assert.match(r.roleGuess ?? "", /Software Engineer Intern/i);
}

// Hypothetical interview language must not become interview status
{
  const r = classifyWithRules(
    msg({
      subject: "Application received — next steps",
      bodyExcerpt:
        "Thank you for your application. Our interview process includes several rounds. We will contact you if selected for an interview.",
    })
  );
  assert.equal(r.isLikelyJob, true);
  assert.equal(r.status, "applied");
}

// Real interview invite
{
  const r = classifyWithRules(
    msg({
      subject: "Interview invitation — Acme Corp",
      bodyExcerpt:
        "You are invited to schedule an interview with Acme for the Backend Engineer role.",
      fromAddress: "Acme Recruiting <talent@acme.com>",
    })
  );
  assert.equal(r.isLikelyJob, true);
  assert.equal(r.status, "interview");
  assert.match(r.roleGuess ?? "", /Backend Engineer/i);
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
