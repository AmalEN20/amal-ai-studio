# Acquisition OS research pipeline

The research workflow has one measurable contract: when the owner requests 50 qualified opportunities, it keeps discovering and auditing candidates until it either saves 50 qualified leads or records a precise, visible reason why it stopped. It must never silently finish at an unexplained lower number.

## Persisted job model

Each run is stored as a research job in D1. The canonical `leads` table still contains one row per business, while `research_job_leads` is the many-to-many membership table connecting a business to every run in which it appeared. This lets a previously discovered business participate in a new run without duplicating the business or disappearing from the new queue.

The job stores:

- requested target and immutable campaign plan;
- current market, page token, and Places request count;
- raw, unique, duplicate, checked, qualified, rejected, and failed counts;
- `running`, `complete`, `partial`, `failed`, or `cancelled` status;
- last error, explicit stop reason, heartbeat, and short lease.

The browser only starts or resumes work and polls progress. It is not the system of record. Reloading the page must not destroy the run.

## Work loop

One `/step` call performs a bounded amount of work:

1. Claim the job with a short D1 lease so duplicate browser requests cannot process it twice.
2. Audit a small batch of pending candidates with bounded concurrency.
3. If the pending queue is empty, fetch the next Places page (20 results) or advance to the next planned market.
4. Upsert canonical leads and attach them to the current job with `INSERT OR IGNORE`.
5. Persist counters and release the lease.
6. Mark the job complete immediately when the requested qualified count is reached.

The UI may call the step endpoint again while the job is running. A saved running job exposes **Resume saved search** after a reload.

## Qualification order

Research should reject obvious poor fits before paying for slower checks:

1. Safe public-website fetch with SSRF, redirect, size, and timeout protections.
2. Deterministic studio V1 fit checks: no patient/client portal, core online booking, ecommerce, SaaS, large content-heavy site, or direct web/marketing competitor.
3. Fast AI audit for viable small marketing-site candidates.
4. PageSpeed and public-email enrichment only after qualification or when the owner requests deeper review.

Research never sends email and never prepares outreach automatically. Sending remains a separate owner-approved action.

## Safety and cost controls

- Places requests use `pageSize: 20` and supported page tokens, with a hard persisted request cap.
- Website checks keep the existing public-only URL validation and bounded response size.
- AI calls keep the monthly local budget check and use small bounded concurrency.
- Every safety cap produces a `partial` job with a human-readable stop reason; it never masquerades as success.
- Duplicate candidates do not consume another audit when a recent compatible audit can be reused.

## Operator interpretation

- **Complete**: the saved qualified count reached the exact requested target.
- **Running**: the job can continue; progress and heartbeat are current.
- **Partial**: the system exhausted its safe market/page/request plan before reaching the target. The stop reason explains which cap or source was exhausted.
- **Failed**: an unrecoverable job-level error occurred. Individual candidate failures are counted separately and do not end an otherwise healthy run.

The useful funnel is `raw → unique → checked → qualified`, with duplicate, rejected, and failed counts shown alongside it. A total such as “21 / 50” is acceptable only while running or when accompanied by a clear partial stop reason.
