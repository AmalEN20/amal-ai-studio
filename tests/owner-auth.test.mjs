import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("owner auth fails closed and local bypass is explicitly development-only", async () => {
  const [ownerAuth, dashboardPage, usagePage, envExample, readme] =
    await Promise.all([
      source("lib/owner-auth.ts"),
      source("app/page.tsx"),
      source("app/usage/page.tsx"),
      source(".env.example"),
      source("README.md"),
    ]);

  assert.match(ownerAuth, /ALLOW_LOCAL_OWNER_BYPASS/);
  assert.match(ownerAuth, /NODE_ENV === "production"/);
  assert.match(ownerAuth, /if \(!ownerEmail\)/);
  assert.match(ownerAuth, /status:\s*503/);
  assert.doesNotMatch(
    ownerAuth,
    /if \(hostname === "localhost"[^\n]*return null/,
  );
  // Regression: a bare "localhost:3000" host header parses as a URL with
  // scheme "localhost:" and an EMPTY hostname. The empty first parse must be
  // rejected so the http-prefixed fallback parse can extract the real host.
  assert.match(
    ownerAuth,
    /if \(parsed\.hostname\) return parsed\.hostname\.toLowerCase\(\);/,
  );

  for (const page of [dashboardPage, usagePage]) {
    assert.match(page, /isLocalOwnerBypassAllowed/);
    assert.match(page, /getConfiguredOwnerEmail/);
    assert.match(page, /!localMode && !ownerEmail/);
    assert.doesNotMatch(page, /host\.startsWith\(/);
  }

  assert.match(envExample, /ALLOW_LOCAL_OWNER_BYPASS=false/);
  assert.match(readme, /ALLOW_LOCAL_OWNER_BYPASS=true/);
  assert.match(readme, /OWNER_EMAIL.*required/i);
});
