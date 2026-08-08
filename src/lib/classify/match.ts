import type { Application } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { ClassificationResult } from "@/lib/classify/llm";
import type { ParsedGmailMessage } from "@/lib/gmail";

function normalizeCompany(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b(inc|llc|ltd|corp|corporation|company|co)\b\.?/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export async function findMatchingApplication(
  userId: string,
  message: ParsedGmailMessage,
  classification: ClassificationResult
): Promise<Application | null> {
  if (message.gmailThreadId) {
    const byThread = await prisma.emailEvent.findFirst({
      where: {
        userId,
        gmailThreadId: message.gmailThreadId,
        applicationId: { not: null },
      },
      include: { application: true },
      orderBy: { receivedAt: "desc" },
    });
    if (byThread?.application && !byThread.application.dismissed) {
      return byThread.application;
    }
  }

  if (!classification.company) return null;

  const target = normalizeCompany(classification.company);
  if (!target) return null;

  const apps = await prisma.application.findMany({
    where: { userId, dismissed: false },
  });

  const companyMatches = apps.filter(
    (app) => normalizeCompany(app.company) === target
  );

  if (companyMatches.length === 0) return null;
  if (companyMatches.length === 1) return companyMatches[0];

  if (classification.role) {
    const roleNorm = classification.role.toLowerCase();
    const roleMatch = companyMatches.find(
      (app) => app.role && app.role.toLowerCase().includes(roleNorm.slice(0, 20))
    );
    if (roleMatch) return roleMatch;
  }

  return companyMatches.sort(
    (a, b) => (b.updatedAt?.getTime() ?? 0) - (a.updatedAt?.getTime() ?? 0)
  )[0];
}

export async function refreshApplicationStatus(applicationId: string) {
  const app = await prisma.application.findUnique({
    where: { id: applicationId },
  });
  if (!app) return null;

  if (app.statusOverride) {
    return prisma.application.update({
      where: { id: applicationId },
      data: { status: app.statusOverride },
    });
  }

  const latest = await prisma.emailEvent.findFirst({
    where: {
      applicationId,
      isJobRelated: true,
      inferredStatus: { not: null },
    },
    orderBy: { receivedAt: "desc" },
  });

  if (!latest?.inferredStatus) return app;

  return prisma.application.update({
    where: { id: applicationId },
    data: {
      status: latest.inferredStatus,
      statusSourceEmailId: latest.id,
      confidence: latest.confidence,
    },
  });
}
