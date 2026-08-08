import { prisma } from "@/lib/prisma";
import { getSheetsClient } from "@/lib/google";
import { STATUS_LABELS, type JobStatus } from "@/lib/types";

const APPLICATION_HEADERS = [
  "App ID",
  "Company",
  "Role",
  "Applied date",
  "Status",
  "Last update",
  "Latest email",
  "Confidence",
];

const EMAIL_HEADERS = [
  "App ID",
  "Date",
  "From",
  "Subject",
  "Inferred status",
  "Gmail link",
];

function sheetDate(value: Date | null | undefined): string {
  if (!value) return "";
  return value.toISOString().slice(0, 10);
}

export async function ensureUserSpreadsheet(userId: string): Promise<string> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new Error("User not found");
  if (user.sheetId) return user.sheetId;

  const sheets = await getSheetsClient(userId);
  const created = await sheets.spreadsheets.create({
    requestBody: {
      properties: {
        title: `Job Tracker — ${user.email ?? user.name ?? "Applications"}`,
      },
      sheets: [
        { properties: { title: "Applications", index: 0 } },
        { properties: { title: "Emails", index: 1 } },
      ],
    },
  });

  const spreadsheetId = created.data.spreadsheetId;
  if (!spreadsheetId) throw new Error("Failed to create spreadsheet");

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: "Applications!A1:H1",
    valueInputOption: "RAW",
    requestBody: { values: [APPLICATION_HEADERS] },
  });

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: "Emails!A1:F1",
    valueInputOption: "RAW",
    requestBody: { values: [EMAIL_HEADERS] },
  });

  await prisma.user.update({
    where: { id: userId },
    data: { sheetId: spreadsheetId },
  });

  return spreadsheetId;
}

export async function syncApplicationToSheet(userId: string, applicationId: string) {
  const spreadsheetId = await ensureUserSpreadsheet(userId);
  const sheets = await getSheetsClient(userId);

  const app = await prisma.application.findFirst({
    where: { id: applicationId, userId },
    include: {
      emails: {
        where: { isJobRelated: true },
        orderBy: { receivedAt: "desc" },
        take: 1,
      },
    },
  });

  if (!app || app.dismissed) return;

  const latestEmail = app.emails[0];
  const status = app.statusOverride ?? app.status;
  const row = [
    app.id,
    app.company,
    app.role ?? "",
    sheetDate(app.appliedAt),
    STATUS_LABELS[status as JobStatus] ?? status,
    sheetDate(app.updatedAt),
    latestEmail?.gmailLink ?? "",
    app.confidence,
  ];

  if (app.sheetRowNumber) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `Applications!A${app.sheetRowNumber}:H${app.sheetRowNumber}`,
      valueInputOption: "RAW",
      requestBody: { values: [row] },
    });
  } else {
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: "Applications!A:H",
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: [row] },
    });

    const listed = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: "Applications!A:A",
    });
    const rowNumber = listed.data.values?.length ?? 2;

    await prisma.application.update({
      where: { id: app.id },
      data: { sheetRowNumber: rowNumber },
    });
  }

  await prisma.user.update({
    where: { id: userId },
    data: { sheetSyncedAt: new Date() },
  });
}

export async function appendEmailToSheet(userId: string, emailEventId: string) {
  const spreadsheetId = await ensureUserSpreadsheet(userId);
  const sheets = await getSheetsClient(userId);
  const event = await prisma.emailEvent.findFirst({
    where: { id: emailEventId, userId },
  });
  if (!event?.applicationId) return;

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: "Emails!A:F",
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: {
      values: [
        [
          event.applicationId,
          sheetDate(event.receivedAt),
          event.fromAddress,
          event.subject,
          event.inferredStatus ?? "",
          event.gmailLink,
        ],
      ],
    },
  });
}

export function spreadsheetUrl(sheetId: string): string {
  return `https://docs.google.com/spreadsheets/d/${sheetId}/edit`;
}
