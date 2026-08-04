"use client";

import { useEffect, useState } from "react";

type UsageTotals = {
  calls: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
};

type UsageSummary = {
  monthStart: string;
  month: UsageTotals;
  allTime: UsageTotals;
  monthlyBudgetUsd: number;
  remainingBudgetUsd: number;
  budgetUsedPercent: number;
  byFeature: Array<{
    feature: "campaign_plan" | "lead_audit" | "outreach_draft" | "site_generation";
    calls: number;
    totalTokens: number;
    estimatedCostUsd: number;
  }>;
};

type UsagePayload = {
  configured: boolean;
  model: string;
  summary: UsageSummary;
  error?: string;
};

const FEATURE_LABELS: Record<UsageSummary["byFeature"][number]["feature"], string> = {
  campaign_plan: "Campaign planning",
  lead_audit: "Lead qualification",
  outreach_draft: "Outreach drafting",
  site_generation: "Website generation",
};

export function AiUsageDashboard({ ownerName }: { ownerName: string }) {
  const [payload, setPayload] = useState<UsagePayload | null>(null);
  const [budget, setBudget] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function loadUsage() {
    setError(null);
    const response = await fetch("/api/ai-usage", { cache: "no-store" });
    const result = (await response.json()) as UsagePayload;
    if (!response.ok || result.error) throw new Error(result.error || "Could not load AI usage");
    setPayload(result);
    setBudget(String(result.summary.monthlyBudgetUsd));
  }

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadUsage().catch((usageError) => {
        setError(usageError instanceof Error ? usageError.message : "Could not load AI usage");
      });
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  async function saveBudget(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/ai-usage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ monthlyBudgetUsd: Number(budget) }),
      });
      const result = (await response.json()) as UsagePayload;
      if (!response.ok || result.error) throw new Error(result.error || "Could not save the budget");
      setPayload(result);
      setBudget(String(result.summary.monthlyBudgetUsd));
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Could not save the budget");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="usage-page">
      <header className="usage-topbar">
        {/* The Sites runtime currently loads a duplicate React copy through next/link. */}
        {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
        <a href="/">← Acquisition dashboard</a>
        <span>{ownerName} / OWNER</span>
      </header>

      <section className="usage-hero">
        <div>
          <p>AMAL AI / OPERATIONS 02</p>
          <h1>AI usage,<br />without dashboard noise.</h1>
        </div>
        <div className="usage-model-card">
          <span>ACTIVE MODEL</span>
          <strong>{payload?.model ?? "Loading…"}</strong>
          <small>{payload?.configured ? "OpenAI API connected" : "Fallback mode — API key not configured"}</small>
        </div>
      </section>

      {error && <div className="error-notice" role="alert">{error}</div>}

      {!payload ? (
        <div className="usage-loading">Reading private usage ledger…</div>
      ) : (
        <>
          <section className="usage-ledger" aria-label="AI usage this month">
            <UsageMetric label="API calls" value={formatNumber(payload.summary.month.calls)} />
            <UsageMetric label="Input tokens" value={formatNumber(payload.summary.month.inputTokens)} />
            <UsageMetric label="Output tokens" value={formatNumber(payload.summary.month.outputTokens)} />
            <UsageMetric label="Total tokens" value={formatNumber(payload.summary.month.totalTokens)} />
            <UsageMetric label="Estimated spend" value={formatUsd(payload.summary.month.estimatedCostUsd)} />
            <UsageMetric label="Local budget remaining" value={formatUsd(payload.summary.remainingBudgetUsd)} dark />
          </section>

          <section className="usage-budget-section">
            <div className="usage-budget-copy">
              <span>MONTHLY CONTROL</span>
              <h2>{formatUsd(payload.summary.month.estimatedCostUsd)} used of {formatUsd(payload.summary.monthlyBudgetUsd)}</h2>
              <p>New AI requests stop automatically at this limit. The owner-level hard cap is $30/month; OpenAI bills the platform account separately based on actual API usage.</p>
              <div className="usage-budget-track"><span style={{ width: `${payload.summary.budgetUsedPercent}%` }} /></div>
            </div>
            <form onSubmit={saveBudget}>
              <label htmlFor="monthly-ai-budget">Monthly budget, USD</label>
              <div>
                <input id="monthly-ai-budget" min="1" max="30" step="1" type="number" value={budget} onChange={(event) => setBudget(event.target.value)} />
                <button disabled={busy} type="submit">{busy ? "Saving…" : "Save budget"}</button>
              </div>
            </form>
          </section>

          <section className="usage-feature-section">
            <div className="usage-section-heading">
              <span>THIS MONTH</span>
              <h2>Cost by AI task</h2>
            </div>
            <div className="usage-feature-table">
              {payload.summary.byFeature.length === 0 ? (
                <p>No paid AI calls have been recorded this month.</p>
              ) : payload.summary.byFeature.map((item) => (
                <div key={item.feature}>
                  <strong>{FEATURE_LABELS[item.feature]}</strong>
                  <span>{item.calls} calls</span>
                  <span>{formatNumber(item.totalTokens)} tokens</span>
                  <b>{formatUsd(item.estimatedCostUsd)}</b>
                </div>
              ))}
            </div>
          </section>

          <footer className="usage-footer">
            <span>All-time tracked usage: {formatNumber(payload.summary.allTime.totalTokens)} tokens</span>
            <button onClick={() => void loadUsage().catch((usageError) => setError(usageError instanceof Error ? usageError.message : "Refresh failed"))} type="button">Refresh ledger</button>
          </footer>
        </>
      )}
    </main>
  );
}

function UsageMetric({ label, value, dark = false }: { label: string; value: string; dark?: boolean }) {
  return <div className={dark ? "dark" : ""}><span>{label}</span><strong>{value}</strong></div>;
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US", { notation: value >= 10_000 ? "compact" : "standard" }).format(value);
}

function formatUsd(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: value > 0 && value < 0.01 ? 4 : 2,
  }).format(value);
}
