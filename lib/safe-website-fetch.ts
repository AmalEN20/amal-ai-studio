const BLOCKED_HOST_SUFFIXES = [
  ".example",
  ".internal",
  ".invalid",
  ".lan",
  ".local",
  ".localhost",
  ".test",
  ".home.arpa",
];

const MAX_REDIRECTS = 4;

export type PublicHtmlPage = {
  html: string;
  url: string;
};

function blockedIpv4(hostname: string): boolean {
  const parts = hostname.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return false;
  const octets = parts.map(Number);
  if (octets.some((octet) => octet < 0 || octet > 255)) return true;
  const [a, b, c] = octets;

  return a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224;
}

function blockedIpv6(hostname: string): boolean {
  if (!hostname.includes(":")) return false;
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    /^fe[89ab]/.test(normalized) ||
    normalized.startsWith("ff") ||
    normalized.startsWith("2001:db8") ||
    normalized.startsWith("::ffff:") ||
    normalized.startsWith("64:ff9b:");
}

export function publicWebsiteUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    if (url.port && !(
      (url.protocol === "http:" && url.port === "80") ||
      (url.protocol === "https:" && url.port === "443")
    )) return null;

    const hostname = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
    if (!hostname || hostname === "localhost" || hostname === "metadata.google.internal") return null;
    if (!hostname.includes(".") && !hostname.includes(":")) return null;
    if (BLOCKED_HOST_SUFFIXES.some((suffix) => hostname === suffix.slice(1) || hostname.endsWith(suffix))) return null;
    if (blockedIpv4(hostname) || blockedIpv6(hostname)) return null;

    url.hash = "";
    return url;
  } catch {
    return null;
  }
}

async function readLimitedText(response: Response, maxBytes: number): Promise<string | null> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) return null;
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

export async function fetchPublicHtml(
  value: string,
  options: { maxBytes: number; timeoutMs: number },
): Promise<PublicHtmlPage | null> {
  let current = publicWebsiteUrl(value);
  if (!current) return null;

  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    try {
      const response = await fetch(current, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; StudioResearch/1.0)" },
        redirect: "manual",
        signal: AbortSignal.timeout(options.timeoutMs),
      });

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location || redirectCount === MAX_REDIRECTS) return null;
        current = publicWebsiteUrl(new URL(location, current).toString());
        if (!current) return null;
        continue;
      }

      if (!response.ok) return null;
      const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
      if (!/^text\/html(?:\s*;|$)/.test(contentType)) return null;
      const html = await readLimitedText(response, options.maxBytes);
      return html === null ? null : { html, url: current.toString() };
    } catch {
      return null;
    }
  }

  return null;
}
