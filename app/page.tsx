import { headers } from "next/headers";
import { requireChatGPTUser } from "@/app/chatgpt-auth";
import { Dashboard } from "@/app/components/Dashboard";
import {
  getConfiguredOwnerEmail,
  isLocalOwnerBypassAllowed,
} from "@/lib/owner-auth";

export const dynamic = "force-dynamic";

export default async function Home() {
  const requestHeaders = await headers();
  const host = requestHeaders.get("host") ?? "";
  const localMode = isLocalOwnerBypassAllowed(host);
  const ownerEmail = getConfiguredOwnerEmail();

  if (!localMode && !ownerEmail) {
    return (
      <main className="access-denied">
        <span>Private studio</span>
        <h1>Owner access is not configured</h1>
        <p>Set the hosted owner allowlist before opening this dashboard.</p>
      </main>
    );
  }

  const user = localMode
    ? { displayName: "Studio Owner", email: "owner@local", fullName: null }
    : await requireChatGPTUser("/");

  if (!localMode && user.email.trim().toLowerCase() !== ownerEmail) {
    return (
      <main className="access-denied">
        <span>Private studio</span>
        <h1>Owner access only</h1>
        <p>This dashboard is available only to the verified owner.</p>
      </main>
    );
  }

  return <Dashboard ownerName={user.displayName} localMode={localMode} />;
}
