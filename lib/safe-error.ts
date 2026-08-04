const MAX_ERROR_DEPTH = 6;
const MAX_CLIENT_ERROR_LENGTH = 300;

export function safeOperationalErrorMessage(
  error: unknown,
  fallback = "Unexpected error",
): string {
  const messages = errorMessages(error);
  const combined = messages.join(" ");

  if (/too many sql variables/i.test(combined)) {
    return "Database query exceeded Cloudflare D1's safe parameter limit.";
  }
  if (/no such (?:table|column)/i.test(combined)) {
    return "Database schema is not ready for this research query.";
  }
  if (/\bD1(?:_[A-Z0-9]+)+\b|Failed query:/i.test(combined)) {
    return "Database query failed while processing research results.";
  }

  const outer = sanitizeMessage(messages[0] ?? "");
  return outer || fallback;
}

function errorMessages(error: unknown): string[] {
  const messages: string[] = [];
  const seen = new Set<unknown>();
  let current = error;

  for (let depth = 0; depth < MAX_ERROR_DEPTH; depth += 1) {
    if (seen.has(current)) break;
    seen.add(current);

    if (current instanceof Error) {
      messages.push(current.message);
      current = safeErrorCause(current);
      continue;
    }
    if (typeof current === "string") messages.push(current);
    break;
  }
  return messages;
}

function safeErrorCause(error: Error): unknown {
  try {
    return error.cause;
  } catch {
    return undefined;
  }
}

function sanitizeMessage(message: string): string {
  return message
    .split(/\b(?:params?|bindings?)\s*:/i, 1)[0]
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_CLIENT_ERROR_LENGTH);
}
