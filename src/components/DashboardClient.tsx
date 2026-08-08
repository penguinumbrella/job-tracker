"use client";

import { Fragment, useCallback, useEffect, useState, useTransition } from "react";
import { signOut } from "next-auth/react";
import { formatDistanceToNow } from "date-fns";
import { JOB_STATUSES, STATUS_LABELS, type JobStatus } from "@/lib/types";

type EmailEvent = {
  id: string;
  subject: string;
  fromAddress: string;
  receivedAt: string;
  inferredStatus: string | null;
  gmailLink: string;
  confidence: string;
};

type Application = {
  id: string;
  company: string;
  role: string | null;
  appliedAt: string | null;
  status: string;
  statusOverride: string | null;
  confidence: string;
  notes: string | null;
  updatedAt: string;
  emails: EmailEvent[];
};

type DashboardPayload = {
  applications: Application[];
  lastSyncedAt: string | null;
  sheetUrl: string | null;
  gmailWatchExpiry: string | null;
};

function statusTone(status: string): string {
  switch (status) {
    case "offer":
      return "bg-emerald-100 text-emerald-900";
    case "interview":
    case "assessment":
      return "bg-sky-100 text-sky-900";
    case "rejected":
    case "withdrawn":
      return "bg-rose-100 text-rose-900";
    case "applied":
    case "under_review":
      return "bg-amber-100 text-amber-950";
    default:
      return "bg-stone-100 text-stone-700";
  }
}

function displayStatus(app: Application): string {
  return app.statusOverride ?? app.status;
}

export function DashboardClient({
  userName,
  userEmail,
}: {
  userName?: string | null;
  userEmail?: string | null;
}) {
  const [data, setData] = useState<DashboardPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<"all" | JobStatus>("all");

  const load = useCallback(async () => {
    const res = await fetch("/api/applications");
    if (!res.ok) throw new Error("Failed to load applications");
    setData((await res.json()) as DashboardPayload);
  }, []);

  useEffect(() => {
    load().catch((err) =>
      setError(err instanceof Error ? err.message : String(err))
    );
  }, [load]);

  function runSync(mode: "full" | "incremental") {
    setSyncMessage(null);
    setError(null);
    startTransition(async () => {
      try {
        const res = await fetch("/api/sync", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mode }),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error ?? "Sync failed");
        setSyncMessage(
          `Scanned ${json.scanned}, created ${json.createdApplications}, updated ${json.updatedApplications}, skipped ${json.skipped}` +
            (json.errors?.length ? ` (${json.errors.length} warnings)` : "")
        );
        await load();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    });
  }

  async function updateApplication(id: string, patch: Record<string, unknown>) {
    const res = await fetch(`/api/applications/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      throw new Error(json.error ?? "Update failed");
    }
    await load();
  }

  const filteredApplications =
    data?.applications.filter((app) => {
      if (statusFilter === "all") return true;
      return displayStatus(app) === statusFilter;
    }) ?? [];

  const statusCounts = (data?.applications ?? []).reduce(
    (acc, app) => {
      const s = displayStatus(app);
      acc[s] = (acc[s] ?? 0) + 1;
      return acc;
    },
    {} as Record<string, number>
  );

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-4 py-8 sm:px-6">
      <header className="flex flex-col gap-4 border-b border-stone-200 pb-6 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-sm uppercase tracking-[0.2em] text-teal-800/70">
            Job Tracker
          </p>
          <h1 className="mt-1 font-[family-name:var(--font-display)] text-3xl text-stone-900 sm:text-4xl">
            Applications
          </h1>
          <p className="mt-2 text-stone-600">
            Signed in as {userName || userEmail}
            {data?.lastSyncedAt
              ? ` · Last sync ${formatDistanceToNow(new Date(data.lastSyncedAt), { addSuffix: true })}`
              : " · Not synced yet"}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {data?.sheetUrl && (
            <a
              href={data.sheetUrl}
              target="_blank"
              rel="noreferrer"
              className="rounded-md border border-stone-300 bg-white px-3 py-2 text-sm text-stone-800 hover:bg-stone-50"
            >
              Open Google Sheet
            </a>
          )}
          <button
            type="button"
            disabled={isPending}
            onClick={() => runSync("incremental")}
            className="rounded-md border border-stone-300 bg-white px-3 py-2 text-sm text-stone-800 hover:bg-stone-50 disabled:opacity-50"
          >
            Sync new mail
          </button>
          <button
            type="button"
            disabled={isPending}
            onClick={() => runSync("full")}
            className="rounded-md bg-teal-800 px-3 py-2 text-sm text-teal-50 hover:bg-teal-900 disabled:opacity-50"
          >
            {isPending ? "Syncing…" : "Full sync (90 days)"}
          </button>
          <button
            type="button"
            onClick={() => signOut({ callbackUrl: "/" })}
            className="rounded-md px-3 py-2 text-sm text-stone-500 hover:text-stone-800"
          >
            Sign out
          </button>
        </div>
      </header>

      {error && (
        <div className="rounded-md border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-900">
          {error}
        </div>
      )}
      {syncMessage && (
        <div className="rounded-md border border-teal-200 bg-teal-50 px-4 py-3 text-sm text-teal-950">
          {syncMessage}
        </div>
      )}

      {!data ? (
        <p className="text-stone-500">Loading applications…</p>
      ) : data.applications.length === 0 ? (
        <div className="rounded-lg border border-dashed border-stone-300 bg-white/70 px-6 py-16 text-center">
          <h2 className="font-[family-name:var(--font-display)] text-2xl text-stone-900">
            No applications yet
          </h2>
          <p className="mx-auto mt-2 max-w-md text-stone-600">
            Full sync only keeps emails that show you already applied (or a later
            hiring stage)—not job alerts or “new opening” digests. Company names
            are pulled from phrases like “we received your application at …”.
          </p>
          <button
            type="button"
            disabled={isPending}
            onClick={() => runSync("full")}
            className="mt-6 rounded-md bg-teal-800 px-4 py-2.5 text-sm text-teal-50 hover:bg-teal-900 disabled:opacity-50"
          >
            {isPending ? "Syncing…" : "Scan Gmail now"}
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <label className="flex items-center gap-2 text-sm text-stone-600">
              Status
              <select
                className="rounded-md border border-stone-300 bg-white px-3 py-2 text-sm text-stone-900"
                value={statusFilter}
                onChange={(e) =>
                  setStatusFilter(e.target.value as "all" | JobStatus)
                }
              >
                <option value="all">
                  All statuses ({data.applications.length})
                </option>
                {JOB_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {STATUS_LABELS[s]}
                    {statusCounts[s] ? ` (${statusCounts[s]})` : ""}
                  </option>
                ))}
              </select>
            </label>
            <p className="text-xs text-stone-500">
              Sorted by applied date (newest first)
            </p>
          </div>

          {filteredApplications.length === 0 ? (
            <div className="rounded-lg border border-dashed border-stone-300 bg-white/70 px-6 py-12 text-center text-stone-600">
              No applications with this status.
            </div>
          ) : (
        <div className="overflow-x-auto rounded-lg border border-stone-200 bg-white shadow-sm">
          <table className="min-w-full text-left text-sm">
            <thead className="border-b border-stone-200 bg-stone-50 text-xs uppercase tracking-wide text-stone-500">
              <tr>
                <th className="px-4 py-3 font-medium">Company</th>
                <th className="px-4 py-3 font-medium">Role</th>
                <th className="px-4 py-3 font-medium">Applied</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">Latest email</th>
                <th className="px-4 py-3 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredApplications.map((app) => {
                const status = displayStatus(app);
                const latest = app.emails[0];
                const open = expandedId === app.id;
                return (
                  <Fragment key={app.id}>
                    <tr className="border-b border-stone-100 align-top hover:bg-stone-50/80">
                      <td className="px-4 py-3 font-medium text-stone-900">
                        {app.company}
                        <div className="mt-0.5 text-xs font-normal text-stone-400">
                          {app.confidence} confidence
                        </div>
                      </td>
                      <td className="px-4 py-3 text-stone-700">
                        {app.role || "—"}
                      </td>
                      <td className="px-4 py-3 text-stone-600">
                        {app.appliedAt
                          ? new Date(app.appliedAt).toLocaleDateString()
                          : "—"}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${statusTone(status)}`}
                        >
                          {STATUS_LABELS[status as JobStatus] ?? status}
                          {app.statusOverride ? " (pinned)" : ""}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        {latest ? (
                          <a
                            href={latest.gmailLink}
                            target="_blank"
                            rel="noreferrer"
                            className="text-teal-800 underline-offset-2 hover:underline"
                          >
                            {latest.subject.slice(0, 48)}
                            {latest.subject.length > 48 ? "…" : ""}
                          </a>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <button
                          type="button"
                          className="text-xs text-stone-600 hover:text-stone-900"
                          onClick={() => setExpandedId(open ? null : app.id)}
                        >
                          {open ? "Hide" : "Edit"}
                        </button>
                      </td>
                    </tr>
                    {open && (
                      <tr className="border-b border-stone-200 bg-stone-50">
                        <td colSpan={6} className="px-4 py-4">
                          <ApplicationEditor
                            app={app}
                            onSave={async (patch) => {
                              await updateApplication(app.id, patch);
                              setExpandedId(null);
                            }}
                            onDismiss={async () => {
                              await updateApplication(app.id, {
                                dismissed: true,
                              });
                              setExpandedId(null);
                            }}
                          />
                          {app.emails.length > 0 && (
                            <div className="mt-4">
                              <p className="text-xs font-medium uppercase tracking-wide text-stone-500">
                                Related emails
                              </p>
                              <ul className="mt-2 space-y-1">
                                {app.emails.map((email) => (
                                  <li key={email.id} className="text-sm">
                                    <a
                                      href={email.gmailLink}
                                      target="_blank"
                                      rel="noreferrer"
                                      className="text-teal-800 hover:underline"
                                    >
                                      {new Date(
                                        email.receivedAt
                                      ).toLocaleDateString()}{" "}
                                      — {email.subject}
                                    </a>
                                    {email.inferredStatus && (
                                      <span className="ml-2 text-xs text-stone-500">
                                        ({email.inferredStatus})
                                      </span>
                                    )}
                                  </li>
                                ))}
                              </ul>
                            </div>
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
          )}
        </div>
      )}
    </div>
  );
}

function ApplicationEditor({
  app,
  onSave,
  onDismiss,
}: {
  app: Application;
  onSave: (patch: Record<string, unknown>) => Promise<void>;
  onDismiss: () => Promise<void>;
}) {
  const [company, setCompany] = useState(app.company);
  const [role, setRole] = useState(app.role ?? "");
  const [status, setStatus] = useState(app.statusOverride ?? app.status);
  const [busy, setBusy] = useState(false);

  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end">
      <label className="flex flex-col gap-1 text-xs text-stone-600">
        Company
        <input
          className="rounded border border-stone-300 bg-white px-2 py-1.5 text-sm text-stone-900"
          value={company}
          onChange={(e) => setCompany(e.target.value)}
        />
      </label>
      <label className="flex flex-col gap-1 text-xs text-stone-600">
        Role
        <input
          className="rounded border border-stone-300 bg-white px-2 py-1.5 text-sm text-stone-900"
          value={role}
          onChange={(e) => setRole(e.target.value)}
        />
      </label>
      <label className="flex flex-col gap-1 text-xs text-stone-600">
        Status (pinned override)
        <select
          className="rounded border border-stone-300 bg-white px-2 py-1.5 text-sm text-stone-900"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
        >
          {JOB_STATUSES.map((s) => (
            <option key={s} value={s}>
              {STATUS_LABELS[s]}
            </option>
          ))}
        </select>
      </label>
      <button
        type="button"
        disabled={busy}
        className="rounded-md bg-stone-900 px-3 py-2 text-sm text-white disabled:opacity-50"
        onClick={async () => {
          setBusy(true);
          try {
            await onSave({
              company,
              role: role || null,
              statusOverride: status,
            });
          } finally {
            setBusy(false);
          }
        }}
      >
        Save
      </button>
      <button
        type="button"
        disabled={busy}
        className="rounded-md border border-stone-300 px-3 py-2 text-sm text-stone-700 disabled:opacity-50"
        onClick={async () => {
          setBusy(true);
          try {
            await onSave({ clearStatusOverride: true });
          } finally {
            setBusy(false);
          }
        }}
      >
        Clear override
      </button>
      <button
        type="button"
        disabled={busy}
        className="rounded-md px-3 py-2 text-sm text-rose-700 disabled:opacity-50"
        onClick={async () => {
          setBusy(true);
          try {
            await onDismiss();
          } finally {
            setBusy(false);
          }
        }}
      >
        Not a job / dismiss
      </button>
    </div>
  );
}
