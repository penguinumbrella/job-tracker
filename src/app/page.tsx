import Link from "next/link";
import { redirect } from "next/navigation";
import { auth, signIn } from "@/auth";

export default async function HomePage() {
  const session = await auth();
  if (session?.user) {
    redirect("/dashboard");
  }

  return (
    <main className="relative mx-auto flex min-h-full w-full max-w-5xl flex-col px-6 py-16 sm:px-10 sm:py-24">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-72 bg-[url('data:image/svg+xml,%3Csvg width=%2760%27 height=%2760%27 viewBox=%270 0 60 60%27 xmlns=%27http://www.w3.org/2000/svg%27%3E%3Cg fill=%27none%27 fill-rule=%27evenodd%27%3E%3Cg fill=%27%23115e59%27 fill-opacity=%270.05%27%3E%3Cpath d=%27M36 34v-4h-2v4h-4v2h4v4h2v-4h4v-2h-4zm0-30V0h-2v4h-4v2h4v4h2V6h4V4h-4zM6 34v-4H4v4H0v2h4v4h2v-4h4v-2H6zM6 4V0H4v4H0v2h4v4h2V6h4V4H6z%27/%3E%3C/g%3E%3C/g%3E%3C/svg%3E')] opacity-80" />

      <p className="relative text-sm font-semibold uppercase tracking-[0.25em] text-teal-900/70">
        Job Tracker
      </p>
      <h1 className="relative mt-4 max-w-2xl font-[family-name:var(--font-display)] text-5xl leading-tight text-stone-900 sm:text-6xl">
        Your inbox, turned into an application tracker.
      </h1>
      <p className="relative mt-5 max-w-xl text-lg leading-relaxed text-stone-700">
        Connect Gmail, detect hiring status emails, keep the latest status per
        company, and sync everything into a Google Sheet with links back to each
        message.
      </p>

      <div className="relative mt-10 flex flex-wrap items-center gap-3">
        <form
          action={async () => {
            "use server";
            await signIn("google", { redirectTo: "/dashboard" });
          }}
        >
          <button
            type="submit"
            className="rounded-md bg-teal-900 px-5 py-3 text-sm font-medium text-teal-50 shadow-sm hover:bg-teal-950"
          >
            Continue with Google
          </button>
        </form>
        <Link
          href="https://github.com/penguinumbrella/job-tracker"
          className="rounded-md px-4 py-3 text-sm text-stone-600 hover:text-stone-900"
        >
          View setup notes in README
        </Link>
      </div>

      <section className="relative mt-20 grid gap-8 border-t border-stone-300/70 pt-10 sm:grid-cols-3">
        <div>
          <h2 className="font-[family-name:var(--font-display)] text-xl text-stone-900">
            Classify
          </h2>
          <p className="mt-2 text-sm leading-relaxed text-stone-600">
            Rules catch ATS senders and phrases like “application received.” An
            optional LLM extracts company, role, and status.
          </p>
        </div>
        <div>
          <h2 className="font-[family-name:var(--font-display)] text-xl text-stone-900">
            Track
          </h2>
          <p className="mt-2 text-sm leading-relaxed text-stone-600">
            Related emails roll into one application. Current status always
            follows the latest related message unless you pin an override.
          </p>
        </div>
        <div>
          <h2 className="font-[family-name:var(--font-display)] text-xl text-stone-900">
            Sync
          </h2>
          <p className="mt-2 text-sm leading-relaxed text-stone-600">
            Rows land in Google Sheets with deep links to Gmail. Polling and
            optional Pub/Sub keep updates continuous.
          </p>
        </div>
      </section>
    </main>
  );
}
