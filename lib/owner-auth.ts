import { getChatGPTUser } from "@/app/chatgpt-auth";

const LOCAL_OWNER_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function getConfiguredOwnerEmail(): string | null {
  const ownerEmail = process.env.OWNER_EMAIL?.trim().toLowerCase();
  return ownerEmail || null;
}

export function isLocalOwnerBypassAllowed(requestUrlOrHost: string): boolean {
  if (process.env.NODE_ENV === "production") return false;
  if (process.env.ALLOW_LOCAL_OWNER_BYPASS !== "true") return false;

  const hostname = parseHostname(requestUrlOrHost);
  return hostname !== null && LOCAL_OWNER_HOSTNAMES.has(hostname);
}

export async function guardOwnerApi(request: Request): Promise<Response | null> {
  if (isLocalOwnerBypassAllowed(request.url)) return null;

  const ownerEmail = getConfiguredOwnerEmail();
  if (!ownerEmail) {
    return Response.json(
      { error: "Owner access is not configured" },
      { status: 503 },
    );
  }

  const user = await getChatGPTUser();
  if (!user) {
    return Response.json({ error: "Authentication required" }, { status: 401 });
  }

  if (user.email.trim().toLowerCase() !== ownerEmail) {
    return Response.json({ error: "Owner access only" }, { status: 403 });
  }

  return null;
}

function parseHostname(requestUrlOrHost: string): string | null {
  const value = requestUrlOrHost.trim();
  if (!value) return null;

  // A bare "host:port" value such as "localhost:3000" parses as a URL with
  // scheme "localhost:" and an empty hostname, so only accept the first parse
  // when it actually produced a hostname.
  try {
    const parsed = new URL(value);
    if (parsed.hostname) return parsed.hostname.toLowerCase();
  } catch {
    // fall through to the http-prefixed parse below
  }

  try {
    return new URL(`http://${value}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}
