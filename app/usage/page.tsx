import { headers } from "next/headers";
import { requireChatGPTUser } from "@/app/chatgpt-auth";
import { AiUsageDashboard } from "@/app/components/AiUsageDashboard";
import {
  getConfiguredOwnerEmail,
  isLocalOwnerBypassAllowed,
} from "@/lib/owner-auth";

export const dynamic = "force-dynamic";

export default async function UsagePage() {
  const requestHeaders = await headers();
  const host = requestHeaders.get("host") ?? "";
  const localMode = isLocalOwnerBypassAllowed(host);
  const ownerEmail = getConfiguredOwnerEmail();

  if (!localMode && !ownerEmail) {
    return (
      <main className="access-denied">
        <span>Private studio</span>
        <h1>Owner access is not configured</h1>
        <p>Set the hosted owner allowlist before opening this ledger.</p>
      </main>
    );
  }

  const user = localMode
    ? { displayName: "Studio Owner", email: "owner@local", fullName: null }
    : await requireChatGPTUser("/usage");

  if (!localMode && user.email.trim().toLowerCase() !== ownerEmail) {
    return (
      <main className="access-denied">
        <span>Private studio</span>
        <h1>Owner access only</h1>
        <p>This operations ledger is available only to the verified owner.</p>
      </main>
    );
  }

  return <AiUsageDashboard ownerName={user.displayName} />;
}
