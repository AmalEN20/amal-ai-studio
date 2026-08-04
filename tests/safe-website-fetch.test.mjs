import assert from "node:assert/strict";
import test from "node:test";
import { fetchPublicHtml, publicWebsiteUrl } from "../lib/safe-website-fetch.ts";

test("accepts ordinary public website URLs", () => {
  assert.equal(publicWebsiteUrl("https://www.example.com/path#section")?.toString(), "https://www.example.com/path");
});

test("rejects local, private, encoded, credentialed, and non-web destinations", () => {
  const blocked = [
    "http://localhost",
    "http://127.0.0.1",
    "http://2130706433",
    "http://0x7f000001",
    "http://10.0.0.8",
    "http://169.254.169.254/latest/meta-data",
    "http://192.168.1.10",
    "http://[::1]",
    "http://service.internal",
    "https://metadata.google.internal",
    "https://user:password@example.com",
    "https://example.com:8443",
    "file:///etc/passwd",
  ];

  for (const value of blocked) assert.equal(publicWebsiteUrl(value), null, value);
});

test("revalidates redirects before following them", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(null, { status: 302, headers: { location: "http://127.0.0.1/admin" } });
  };

  try {
    assert.equal(await fetchPublicHtml("https://example.com", { maxBytes: 1_000, timeoutMs: 500 }), null);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rejects non-HTML and oversized responses", async () => {
  const originalFetch = globalThis.fetch;
  const responses = [
    new Response("{}", { headers: { "content-type": "application/json" } }),
    new Response("123456789", { headers: { "content-type": "text/html" } }),
  ];
  globalThis.fetch = async () => responses.shift();

  try {
    assert.equal(await fetchPublicHtml("https://example.com", { maxBytes: 8, timeoutMs: 500 }), null);
    assert.equal(await fetchPublicHtml("https://example.com", { maxBytes: 8, timeoutMs: 500 }), null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
