import Link from "next/link";
import { redirect } from "next/navigation";
import { auth, signIn } from "@/auth";

export default async function HomePage() {
  const session = await auth();
  if (session?.user) redirect("/dashboard");

  return (
    <main className="relative mx-auto flex min-h-full w-full max-w-5xl flex-col px-6 py-16 sm:px-10 sm:py-24">
      <p className="relative text-sm font-semibold uppercase tracking-[0.25em] text-teal-900/70">
        Job Tracker
      </p>
      <h1 className="relative mt-4 max-w-2xl font-[family-name:var(--font-display)] text-5xl leading-tight text-stone-900 sm:text-6xl">
        Your inbox, turned into an application tracker.
      </h1>
      <p className="relative mt-5 max-w-xl text-lg leading-relaxed text-stone-700">
        Connect Gmail, keep only real application confirmations and hiring-stage
        updates, extract the company from the email body, and sync a Google Sheet
        with links back to each message.
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
          Setup notes in README
        </Link>
      </div>
    </main>
  );
}
