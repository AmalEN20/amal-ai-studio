# Security

## Reporting a vulnerability

Please do not publish credentials, personal data, or exploit details in a public
issue. Contact the repository owner privately through the GitHub profile before
sharing a proof of concept.

## Secrets and local configuration

- Copy `.env.example` to `.env.local`; never commit the local file.
- Keep provider credentials in server-side secret controls.
- Keep `OUTREACH_LAUNCH_ENABLED=false` unless an owner intentionally starts a
  reviewed outreach run.
- Rotate and revoke any credential that is ever exposed in source, logs,
  screenshots, or chat.

The repository intentionally excludes local environment files, Cloudflare state,
build output, and private hosting configuration. Missing integrations fail closed
or use clearly labelled deterministic fallbacks.

## Verification

Before publishing a change, run:

```bash
npm run typecheck
npm run lint
npm test
npm audit --omit=dev
```
