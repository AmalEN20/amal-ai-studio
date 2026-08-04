# Acquisition OS end-to-end client flow audit

Date: 2026-07-16
Scope: read-only audit of the path from lead discovery to a paid, approved, deployed website. No email, payment, deployment, or other external action was performed.

## Executive result

The acquisition half of the product is real: owner-only access, Google Places discovery, canonical D1 lead storage, deterministic V1-scope checks, AI-assisted audit/draft generation, owner approval, and a guarded Gmail send path all exist.

The client-delivery half is not implemented yet. A positive reply currently leads to a generated `GeneratedSite` JSON concept. There is no quote, order, payment, customer intake, real code build, real QA, shareable client preview, revision/approval flow, deploy adapter, or handoff record. The OS is therefore ready for controlled research and owner-reviewed outreach, but not yet for an autonomous paid website order.

### Status legend

- **WORKING** — implemented with persistent state and a usable route/UI.
- **MANUAL** — the owner can represent the step, but the system does not observe or automate it.
- **PARTIAL / SEMANTIC** — something is displayed or generated, but it is not the business capability the label implies.
- **MISSING** — no durable model, route, and UI for the step.

## Gap matrix

| Business step | Status | What exists now | Exact evidence | Blocking gap |
|---|---|---|---|---|
| Find businesses | WORKING | Google Places Text Search, paginated research jobs, leases, per-run membership, deduplication by canonical `source_key`. | `app/api/research/jobs/route.ts`, `app/api/research/jobs/step/route.ts`, `db/research-jobs.ts`, `db/leads.ts` | Needs production observability and integration tests, but the core is real. |
| Qualify and save | WORKING | Deterministic V1 scope rejection runs before expensive enrichment; qualified leads are kept in D1 and can be saved for launch. Eligibility is based on objective `serviceFit`, not whether a website is visually weak. | `lib/lead-engine.ts`, `app/api/leads/action/route.ts`, `db/schema.ts` | Contactability should be made an explicit launch gate. Visual quality must stay outreach positioning, never a rejection reason. |
| Website performance | OPTIONAL ENRICHMENT | Bulk research calls `analyzeLead(..., { fast: true })`, which already skips PageSpeed. Owner-triggered full re-check can still call PageSpeed and show the score. | `app/api/research/jobs/step/route.ts`, `lib/lead-engine.ts`, `app/components/Dashboard.tsx` | PageSpeed must not block, rank, or slow bulk qualification. If no measurement was run, outreach may describe the studio's own fast/mobile-first capability, but must not claim the current site is slow. |
| Find contact email | PARTIAL | The owner can run official-site email discovery or enter a public business email manually. | `app/api/leads/action/route.ts`, `lib/lead-engine.ts`, `app/components/Dashboard.tsx` | No explicit email provenance/verified-at fields and no global suppression check by normalized email/domain. |
| Create outreach draft | WORKING | OpenAI or deterministic fallback creates a draft only for V1-compatible leads. | `lib/lead-engine.ts`, `app/api/leads/action/route.ts` | Drafts have no immutable version/hash, editor history, or approver/timestamp record. |
| Approve draft | MANUAL / WORKING | Owner action moves `drafted -> approved`. | `app/api/leads/action/route.ts`, `app/components/Dashboard.tsx` | Approval is not bound to an immutable draft version. A later write can make the approval ambiguous. |
| Send outreach | CONDITIONAL / WORKING | Real send is locked by `OUTREACH_LAUNCH_ENABLED`, owner approval, a public email, Gmail OAuth, and a postal address. Atomic `approved -> sending` claim prevents concurrent duplicate sends. | `app/api/leads/action/route.ts`, `db/leads.ts`, `lib/gmail.ts` | `OUTREACH_LAUNCH_ENABLED` is absent from `.env.example`; no outbox/event log, global suppression table, provider thread ID, bounce tracking, or reconciliation for “Gmail succeeded but D1 final update failed.” |
| Receive and classify reply | MANUAL | Owner clicks “Mark positive reply.” | `app/api/leads/action/route.ts`, `app/components/Dashboard.tsx` | No Gmail read/watch integration, message/thread mapping, inbound event storage, negative-reply classification, or automated unsubscribe parsing. UI text claiming Gmail will be monitored is inaccurate. |
| Record acceptance / scope | MISSING | A positive reply is represented only by lead stage `replied`. | `lib/types.ts`, `db/schema.ts` | Need a distinct opportunity/order and an accepted, versioned scope. A reply is not contractual acceptance. |
| Quote | MISSING | None. | No quote/order modules or tables exist. | Need immutable quote versions, amount/currency, scope, expiry, and accepted version. |
| Payment | MISSING | None. | No payment route/table/provider/webhook exists. | Use hosted checkout; never collect card data in this application. Verify webhook signatures and make provider event IDs unique. |
| Customer intake | MISSING | `/api/projects` accepts owner-authenticated `BusinessInput`; it is not a customer form and is not tied to payment/order state. | `app/api/projects/route.ts`, `lib/types.ts` | Need a public, token-protected, schema-validated intake tied to one paid order and versioned submissions. |
| Generate website | PARTIAL / CONCEPT ONLY | `generateSite` returns structured research, strategy, copy, colors, and stats; lead build guesses `BusinessInput` from scraped data. | `lib/generator.ts`, `app/api/generate/route.ts`, `app/api/leads/action/route.ts` | No Next.js/static artifact, assets, contact-form backend, build log, source bundle, or client-confirmed input. Concurrent build calls are not business-level idempotent. |
| QA | SEMANTIC ONLY | Project status is set to `qa`, then immediately completed. | `app/api/generate/route.ts`, `db/projects.ts` | No build/lint/type/accessibility/link/form/Lighthouse checks and no QA result that can block preview/deploy. |
| Client preview | MISSING | Owner dashboard renders a `SitePreview` from JSON. | `app/components/Dashboard.tsx` | No shareable client URL, expiring token, client identity, version selection, or read-only separation from owner APIs. |
| Revisions and client approval | MISSING | None. | No approval/revision modules or tables exist. | Approval must reference the exact immutable build digest/version. |
| Deploy | SEMANTIC ONLY | `completeProject` marks `deploy` as `ready`; no deployment occurs. | `db/projects.ts`, `.openai/hosting.json` | Need a deploy adapter, provider deployment ID/status/URL, retries, artifact digest, rollback/failure state, and domain workflow. |
| Delivery/handoff | MISSING | Lead stage `delivered` currently means the internal concept was generated. | `app/api/leads/action/route.ts`, `lib/types.ts`, `app/components/Dashboard.tsx` | Delivery must require deployed URL, QA pass, approved build version, ownership/handoff details, and recorded customer notification. |

## Current state model versus required state model

Do not continue adding sales and delivery meanings to `Lead.stage`. Keep acquisition and fulfillment separate.

### Acquisition

`discovered -> qualified -> drafted -> approved -> sending -> sent -> replied_positive | replied_negative | unsubscribed`

The existing `replied` can be migrated to `replied_positive` after inbound reply types exist.

### Order and delivery

`quote_draft -> quote_sent -> quote_accepted -> checkout_pending -> paid -> intake_pending -> intake_submitted -> build_queued -> generating -> qa_pending -> qa_failed | preview_ready -> changes_requested | client_approved -> deploying -> deployed -> delivered`

Additional terminal/exception states: `cancelled`, `payment_failed`, `refunded`, `intake_expired`, `deploy_failed`.

Mandatory guards:

1. Production build requires `paid` and `intake_submitted`. An explicit `internal_demo` mode may bypass this without ever being called “delivered.”
2. Client preview requires a completed artifact and passed QA.
3. Deploy requires approval of the exact build version/digest.
4. Delivery requires a real deployed URL and persisted QA/approval evidence.
5. Refund/cancellation after payment must flag or block further fulfillment according to an explicit owner decision.

## Minimal durable data model

The smallest safe extension is:

- `customers`: normalized customer identity and contact details.
- `orders`: links lead/customer, amount/currency, current state, accepted quote version, optimistic `version`, timestamps.
- `quote_versions`: immutable scope JSON, price, currency, expiry, content hash, status.
- `payments`: order ID, provider, checkout session ID, provider event ID `UNIQUE`, status, amount/currency, timestamps. Store no card details.
- `intake_submissions`: order ID, version, validated answers JSON, status, hashed public token, submitted timestamp.
- `builds`: order/intake version, generation key `UNIQUE`, state, artifact reference/digest, QA JSON, preview token hash/expiry, deploy provider ID/URL.
- `approvals`: build ID/version/digest, actor, decision, comments, timestamp.
- `email_events` or an `outbox`: logical send ID, lead, draft version, Gmail message/thread IDs, state, attempts, timestamps.
- `suppressions`: normalized email/domain, reason, source, timestamp; checked before every send across all lead records.
- `state_events`: append-only transition/audit history for owner-visible diagnosis.

Use D1 for structured workflow metadata and event history. The current Sites app has D1 but no R2 binding (`.openai/hosting.json`). If builds contain source bundles or large assets, add R2 (or another artifact store) rather than storing them as large D1 JSON blobs. Gmail remains authoritative for messages/threads; the payment provider remains authoritative for money; the deployment provider remains authoritative for deployment state, with stable IDs mirrored in D1.

## Idempotency and failure recovery

Every external side effect needs a stable business key, not a random request key created only at call time.

- **Outreach:** `lead_id + immutable_draft_version`. Persist the logical send before Gmail, store message and thread IDs, and reconcile records stuck in `sending`. The existing atomic send claim is a good base.
- **Checkout:** one checkout session per `order_id + quote_version`; pass that as the provider idempotency key.
- **Payment webhook:** verify signature and timestamp, insert provider event ID with a unique constraint, and make a replay a no-op.
- **Intake:** one active hashed token per order; expiration, revocation, and submission version; never store the raw token.
- **Generation:** `order_id + intake_version + build_attempt`; atomically claim `build_queued -> generating` before calling OpenAI/build tools.
- **Deploy:** build ID plus artifact digest; retries must return or reconcile the same deployment rather than create another.
- **All transitions:** update with `WHERE id = ? AND state = ? AND version = ?`; return `409` for stale transitions and append a `state_events` record.

## Security findings

### Existing strengths

- Hosted UI and APIs fail closed when `OWNER_EMAIL` is missing.
- Local owner bypass is explicit, localhost-only, and disabled in production.
- Return paths for ChatGPT auth are restricted to same-origin relative paths.
- Current API routes inspected are owner guarded.
- Website inspection uses the SSRF-oriented safe fetch module and tests.
- Gmail send is server-side and header values are sanitized.
- AI spend is reserved atomically in D1 and hard-capped at $30/month before OpenAI is called.

### Required before launch

1. **Keep operational credentials outside the repository.** Store Google, OpenAI, Places, PageSpeed, and Gmail credentials only in server-side secret controls. If any credential is ever exposed, rotate it immediately and revoke the previous value. Never copy secrets into source, screenshots, chat, browser client code, or logs.
2. **Public customer routes must not reuse owner auth.** Use random 256-bit single-purpose tokens, store only hashes, bind to order/purpose, set expiry/revocation, rate-limit, and return non-enumerating errors.
3. **Use hosted payment UI.** Never handle PAN/CVV. Verify webhook signatures over the raw body, enforce replay protection, and compare amount/currency/order metadata before marking paid.
4. **Global suppression.** Unsubscribe cannot be only a stage on one lead. Block the normalized address (and optionally domain when appropriate) before all future sends.
5. **Immutable approvals and evidence.** Approval must reference exact draft/build hashes. Preserve source URLs and timestamps for factual claims.
6. **Timeouts and reconciliation.** Gmail token/send fetches need explicit timeouts, safe error redaction, and a stuck-send recovery job.
7. **Content integrity.** The prompt tells OpenAI not to invent testimonials/statistics, but `normalizeGeneratedSite` still accepts model-provided values without evidence validation. Enforce empty testimonial fields and structural `01/02/03` stats unless verified source facts are explicitly supplied.
8. **Do not make unsupported performance claims.** Bulk research already skips PageSpeed. Without a measurement, describe the studio's own capability (“fast, mobile-first”) rather than diagnosing the prospect's current site.

## Visible workflow changes

The dashboard should show two clearly separate workspaces:

1. **Acquisition:** research run, objective V1 compatibility, public contact provenance, draft version, approval, send/reply events, suppression state.
2. **Client projects:** quote, payment, intake, current build, QA, client preview, revisions, approval, deploy, handoff.

For each client project, show a timeline and the exact unmet gate. Errors should offer safe retry/reconcile actions without allowing the owner to skip payment, intake, QA, or approval. Rename the current lead `delivered` state to `concept_ready` until a real deployment and handoff exist. Change the sent-stage text from “the system will monitor Gmail” to an explicitly manual instruction until inbound Gmail integration is implemented.

## Minimal implementation sequence

### P0 — truthful, safe current MVP

1. Rename `delivered` to `concept_ready` and remove deploy/QA implications from current labels.
2. Correct the Gmail-monitoring text; replies remain owner-recorded.
3. Add `OUTREACH_LAUNCH_ENABLED=false` to `.env.example` and deployment checklist.
4. Verify operational credentials are stored only in server-side secret controls.
5. Add global suppression plus message/outbox/event state and stuck-send reconciliation.
6. Enforce evidence validation for testimonials, statistics, claims, and outreach observations.
7. Keep PageSpeed out of bulk qualification; offer it only as optional owner-requested diagnostics. Visual/modern need is positioning, not eligibility.

### P1 — sales and money

1. Add customer, order, quote-version, payment, and state-event schema.
2. Add owner quote UI and a signed customer quote/acceptance page.
3. Add hosted checkout and verified, replay-safe webhooks.

### P2 — client intake

1. Add `/intake/[token]` with schema validation, expiry/revocation, autosave or safe final submission.
2. Gate it to the paid order and version every submission.
3. Show customer-confirmed facts separately from scraped research.

### P3 — real build and QA

1. Generate an actual deployable site artifact and contact-form implementation.
2. Persist an idempotent build record and artifact digest/reference.
3. Run real build/type/lint, link, responsive, accessibility, factual-claim, and contact-form smoke checks. A failure must block preview/deploy.

### P4 — client preview, approval, deployment

1. Add signed read-only preview links, comments/revision requests, and approval of an exact build digest.
2. Add a deploy adapter with provider ID/status/URL, retries/reconciliation, and failure reporting.
3. Record handoff/delivery only after deploy and approval.

### P5 — inbound reply automation

Add Gmail read/watch only after scopes, retention, event verification, thread mapping, and security are designed. Let AI classify replies, but require owner confirmation for ambiguous acceptance, scope, or unsubscribe decisions during V1.

## End-to-end test plan

Current tests are mostly source-contract/regex checks. Some can pass when a string exists in dead or legacy code, so they do not prove the running workflow. Add route/database integration tests plus browser E2E with mocked external providers.

### Happy path

1. Start a research job for an exact target; persist canonical leads and per-run membership without duplicates.
2. Reject only unsupported core complexity/direct competitors; do not reject because a site already looks modern or because PageSpeed was not run.
3. Create versioned draft, approve it, double-submit send, and assert exactly one provider call/event.
4. Ingest or manually confirm one positive reply linked to the Gmail thread.
5. Create/accept an immutable quote; replay the successful payment webhook and assert one `paid` transition.
6. Submit a valid one-order intake; expire/revoke the token and verify reuse fails.
7. Request generation twice and assert one claimed build/artifact.
8. Run QA; failure blocks preview/deploy, pass unlocks preview.
9. Client requests changes, a new version is built, and approval references only the new digest.
10. Deploy retry reconciles the same deployment; record the final URL and delivery event.

### Negative and security cases

- Unpaid build and paid-without-intake both return `409`.
- Stale version transition returns `409` and does not overwrite newer state.
- Spoofed payment webhook is rejected; replay is a no-op; mismatched amount/currency never marks paid.
- Expired, revoked, wrong-purpose, or cross-order preview/intake token returns a non-enumerating error.
- Owner APIs return `401/403/503` for missing identity, wrong owner, or missing configuration.
- Global suppression blocks the same normalized email across duplicate/canonical lead paths.
- Simulate Gmail success followed by D1 failure; reconciliation records the sent message without resending.
- Simulate deploy timeout after provider success; retry finds the original deployment.
- Factual-claim validation rejects invented testimonials, awards, business metrics, and unsupported performance diagnoses.
- Logs and API errors contain no secrets, OAuth tokens, raw public-access tokens, full payment payloads, or unnecessary PII.

### Test layers

- Unit: state guards, claim validators, token hashing, factual-claim validation, PageSpeed-independent eligibility.
- Integration: route handlers with test D1 and mocked `fetch` for Places/OpenAI/Gmail/payment/deploy.
- Browser: owner acquisition flow and tokenized quote/intake/preview customer flow.
- Production smoke: demo/sandbox providers only; never a real prospect email or live charge.

## Definition of “launch ready”

The full system is launch ready only when one sandbox order can traverse quote acceptance, replay-safe payment, tokenized intake, idempotent real build, blocking QA, client version approval, deploy, and recorded delivery without direct database edits or misleading status labels. Until then, launch research and owner-reviewed outreach separately from website fulfillment.
