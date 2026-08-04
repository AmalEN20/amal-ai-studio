import { senderDisplayName, studioName } from "@/lib/identity";
import type { Lead } from "@/lib/types";

export class GmailSendError extends Error {
  readonly mayHaveSent: boolean;

  constructor(message: string, mayHaveSent: boolean, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "GmailSendError";
    this.mayHaveSent = mayHaveSent;
  }
}

export function gmailConfigured(): boolean {
  return Boolean(
    process.env.GMAIL_CLIENT_ID?.trim() &&
      process.env.GMAIL_CLIENT_SECRET?.trim() &&
      process.env.GMAIL_REFRESH_TOKEN?.trim() &&
      process.env.GMAIL_SENDER?.trim(),
  );
}

export async function verifyGmailConnection(): Promise<{ sender: string }> {
  if (!gmailConfigured()) throw new Error("Gmail OAuth is not configured");

  const accessToken = await refreshAccessToken();
  const endpoint = new URL("https://oauth2.googleapis.com/tokeninfo");
  endpoint.searchParams.set("access_token", accessToken);
  const response = await fetch(endpoint, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`Google token verification returned ${response.status}`);

  const payload = (await response.json()) as { scope?: string };
  const scopes = new Set((payload.scope ?? "").split(/\s+/).filter(Boolean));
  if (!scopes.has("https://www.googleapis.com/auth/gmail.send")) {
    throw new Error("The Gmail send permission is missing");
  }

  return { sender: process.env.GMAIL_SENDER!.trim() };
}

export async function sendLeadEmail(
  lead: Lead,
): Promise<{ messageId: string; threadId: string }> {
  if (!lead.outreach) throw new Error("Create an outreach draft first");
  if (!lead.email || lead.email.endsWith(".example")) {
    throw new Error("A verified business email is required before sending");
  }
  const postalAddress = process.env.OUTREACH_POSTAL_ADDRESS?.trim();
  if (!postalAddress) {
    throw new Error("OUTREACH_POSTAL_ADDRESS is required for compliant outreach");
  }
  if (!gmailConfigured()) throw new Error("Gmail OAuth is not connected yet");

  const accessToken = await refreshAccessToken();
  const sender = process.env.GMAIL_SENDER!.trim();
  const body = [
    lead.outreach.body.trim(),
    "---",
    studioName(),
    postalAddress,
    "This is a one-to-one business introduction. Reply “unsubscribe” and I will not contact you again.",
  ].join("\n");
  const raw = encodeMime({
    from: `${senderDisplayName()} <${sender}>`,
    to: lead.email,
    subject: lead.outreach.subject,
    body,
  });

  let response: Response;
  try {
    response = await fetch(
      "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ raw }),
        signal: AbortSignal.timeout(20_000),
      },
    );
  } catch (error) {
    // A connection failure after the request leaves the Worker is ambiguous:
    // Gmail may have accepted the message even though no response arrived.
    throw new GmailSendError(
      "Gmail delivery status is unknown. Check Sent mail before taking any action.",
      true,
      error,
    );
  }
  if (!response.ok) {
    const detail = await response.text();
    const ambiguous =
      response.status === 408 || response.status === 409 || response.status >= 500;
    throw new GmailSendError(
      `Gmail API returned ${response.status}: ${detail.slice(0, 180)}`,
      ambiguous,
    );
  }
  const payload = (await response.json()) as { id?: string; threadId?: string };
  if (!payload.id || !payload.threadId) {
    throw new GmailSendError(
      "Gmail accepted the request but did not return complete message/thread ids. Check Sent mail before taking any action.",
      true,
    );
  }
  return { messageId: payload.id, threadId: payload.threadId };
}

async function refreshAccessToken(): Promise<string> {
  const body = new URLSearchParams({
    client_id: process.env.GMAIL_CLIENT_ID!.trim(),
    client_secret: process.env.GMAIL_CLIENT_SECRET!.trim(),
    refresh_token: process.env.GMAIL_REFRESH_TOKEN!.trim(),
    grant_type: "refresh_token",
  });
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as {
      error?: string;
      error_description?: string;
    } | null;
    const reason = [payload?.error, payload?.error_description]
      .filter(Boolean)
      .join(": ")
      .replace(/[\r\n]+/g, " ")
      .slice(0, 120);
    throw new Error(
      reason
        ? `Google OAuth ${response.status}: ${reason}`
        : `Google OAuth returned ${response.status}`,
    );
  }
  const payload = (await response.json()) as { access_token?: string };
  if (!payload.access_token) throw new Error("Google OAuth returned no access token");
  return payload.access_token;
}

function encodeMime(input: {
  from: string;
  to: string;
  subject: string;
  body: string;
}): string {
  const cleanHeader = (value: string) => value.replace(/[\r\n]+/g, " ").trim();
  const mime = [
    `From: ${cleanHeader(input.from)}`,
    `To: ${cleanHeader(input.to)}`,
    `Subject: ${cleanHeader(input.subject)}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: 8bit",
    "",
    input.body.replace(/\r?\n/g, "\r\n"),
  ].join("\r\n");
  const bytes = new TextEncoder().encode(mime);
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
