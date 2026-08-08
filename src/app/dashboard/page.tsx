import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { DashboardClient } from "@/components/DashboardClient";

export default async function DashboardPage() {
  const session = await auth();
  if (!session?.user) {
    redirect("/");
  }

  return (
    <main className="min-h-full">
      <DashboardClient
        userName={session.user.name}
        userEmail={session.user.email}
      />
    </main>
  );
}
