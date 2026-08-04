/**
 * Configurable studio identity.
 *
 * Anyone running their own copy of this project sets `STUDIO_NAME` and
 * `SENDER_NAME` in `.env.local` (or the hosted secret store). Nothing in the
 * codebase should hard-code a personal name, email address, or domain.
 */

export function studioName(): string {
  return process.env.STUDIO_NAME?.trim() || "Amal AI Studio";
}

export function senderName(): string {
  return process.env.SENDER_NAME?.trim() || "Studio Owner";
}

/** "Sender from Studio" — used to identify the sender inside AI prompts. */
export function senderIdentity(): string {
  return `${senderName()} from ${studioName()}`;
}

/** "Sender | Studio" — used for the outgoing email From display name. */
export function senderDisplayName(): string {
  return `${senderName()} | ${studioName()}`;
}
