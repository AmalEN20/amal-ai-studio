"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  Lead,
  ResearchJob,
  ResearchJobLeadStatus,
} from "@/lib/types";
import { LeadDetail } from "./LeadDetail";
import {
  isLaunchReadyLead,
  StagePill,
  type LeadAction,
  type LeadActionInput,
} from "./lead-shared";

type DashboardProps = {
  ownerName: string;
  localMode: boolean;
};

type Integrations = {
  gmail: boolean;
  googlePlaces: boolean;
  pageSpeed: boolean;
  openai: boolean;
  outreachReady: boolean;
  launchEnabled: boolean;
};

type IntegrationCheck = { ok: boolean; detail: string };
type IntegrationChecks = Record<"googlePlaces" | "pageSpeed" | "gmail" | "outreach", IntegrationCheck>;

type ResearchLead = Lead & {
  researchStatus?: ResearchJobLeadStatus;
  researchError?: string;
};

type ResearchSnapshot = {
  job: ResearchJob;
  leads: ResearchLead[];
};

type SavedLaunchState = {
  leads: Lead[];
  count: number;
};

const ACTIVE_RESEARCH_KEY = "amal-ai-os.activeResearchJob";
const STEP_RETRY_MS = 900;

type QueueView = "current" | "history" | "launch";

const TERMINAL_RESEARCH_STATUSES = new Set<ResearchJob["status"]>([
  "complete",
  "partial",
  "failed",
  "cancelled",
]);

export function Dashboard({ ownerName, localMode }: DashboardProps) {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [currentLeads, setCurrentLeads] = useState<ResearchLead[]>([]);
  const [savedLaunch, setSavedLaunch] = useState<SavedLaunchState>({
    leads: [],
    count: 0,
  });
  const [researchJobs, setResearchJobs] = useState<ResearchJob[]>([]);
  const [activeJob, setActiveJob] = useState<ResearchJob | null>(null);
  const [targetQualifiedCount, setTargetQualifiedCount] = useState("25");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [queueView, setQueueView] = useState<QueueView>("current");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [integrations, setIntegrations] = useState<Integrations>({
    gmail: false,
    googlePlaces: false,
    pageSpeed: false,
    openai: false,
    outreachReady: false,
    launchEnabled: false,
  });
  const [checks, setChecks] = useState<IntegrationChecks | null>(null);
  const pollingJobRef = useRef<string | null>(null);
  const pollGenerationRef = useRef(0);

  const loadLeads = useCallback(async () => {
    const response = await fetch("/api/leads", { cache: "no-store" });
    const payload = (await response.json()) as {
      leads?: Lead[];
      savedForLaunchLeads?: Lead[];
      savedForLaunchCount?: number;
      integrations?: Integrations;
      error?: string;
    };
    if (!response.ok) throw new Error(payload.error || "Could not load opportunities");
    const recentLeads = payload.leads ?? [];
    const savedForLaunchLeads =
      payload.savedForLaunchLeads ?? recentLeads.filter(isLaunchReadyLead);
    setLeads(recentLeads);
    setSavedLaunch({
      leads: savedForLaunchLeads,
      count: payload.savedForLaunchCount ?? savedForLaunchLeads.length,
    });
    if (payload.integrations) setIntegrations(payload.integrations);
    return recentLeads;
  }, []);

  const loadResearchJobs = useCallback(async () => {
    const response = await fetch("/api/research/jobs", { cache: "no-store" });
    const payload = (await response.json()) as { jobs?: ResearchJob[]; error?: string };
    if (!response.ok) throw new Error(payload.error || "Could not load saved searches");
    const jobs = payload.jobs ?? [];
    setResearchJobs(jobs);
    return jobs;
  }, []);

  const loadResearchSnapshot = useCallback(async (jobId: string) => {
    const response = await fetch(`/api/research/jobs?id=${encodeURIComponent(jobId)}`, {
      cache: "no-store",
    });
    const payload = (await response.json()) as ResearchSnapshot & { error?: string };
    if (!response.ok || !payload.job) {
      throw new Error(payload.error || "Could not load the saved search");
    }
    setActiveJob(payload.job);
    setCurrentLeads(payload.leads ?? []);
    setSavedLaunch((current) => {
      const savedLeads = mergeSavedForLaunchRecords(current.leads, payload.leads ?? []);
      return { leads: savedLeads, count: savedLeads.length };
    });
    setSelectedId((current) =>
      payload.leads.some((lead) => lead.id === current)
        ? current
        : payload.leads[0]?.id ?? null,
    );
    return payload;
  }, []);

  const runResearchLoop = useCallback(async (jobId: string) => {
    if (pollingJobRef.current === jobId) return;
    const generation = ++pollGenerationRef.current;
    pollingJobRef.current = jobId;
    setBusy("research");
    setError(null);

    try {
      while (
        pollingJobRef.current === jobId &&
        pollGenerationRef.current === generation
      ) {
        const response = await fetch("/api/research/jobs/step", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jobId }),
        });

        if (response.status === 409) {
          await wait(STEP_RETRY_MS);
          continue;
        }

        const payload = (await response.json()) as { job?: ResearchJob; error?: string };
        if (!response.ok || !payload.job) {
          throw new Error(payload.error || "Research step failed");
        }

        const snapshot = await loadResearchSnapshot(jobId);
        if (TERMINAL_RESEARCH_STATUSES.has(snapshot.job.status)) {
          setNotice(researchCompletionNotice(snapshot.job));
          await Promise.all([loadLeads(), loadResearchJobs()]);
          break;
        }

        await wait(120);
      }
    } catch (researchError) {
      setError(
        researchError instanceof Error
          ? researchError.message
          : "Research stopped unexpectedly",
      );
      await loadResearchSnapshot(jobId).catch(() => undefined);
      await loadResearchJobs().catch(() => undefined);
    } finally {
      if (pollGenerationRef.current === generation) {
        pollingJobRef.current = null;
        setBusy(null);
      }
    }
  }, [loadLeads, loadResearchJobs, loadResearchSnapshot]);

  useEffect(() => {
    let cancelled = false;

    async function initialize() {
      try {
        const [, jobs] = await Promise.all([loadLeads(), loadResearchJobs()]);
        if (cancelled) return;
        const savedId = window.localStorage.getItem(ACTIVE_RESEARCH_KEY);
        const savedJob = jobs.find((job) => job.id === savedId);
        const candidate = savedJob ?? jobs.find((job) => job.status === "running") ?? jobs[0];
        if (candidate) {
          window.localStorage.setItem(ACTIVE_RESEARCH_KEY, candidate.id);
          const snapshot = await loadResearchSnapshot(candidate.id);
          if (!cancelled && snapshot.job.status === "running") {
            void runResearchLoop(snapshot.job.id);
          }
        }
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : "Loading failed");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void initialize();
    return () => {
      cancelled = true;
      pollGenerationRef.current += 1;
      pollingJobRef.current = null;
    };
  }, [loadLeads, loadResearchJobs, loadResearchSnapshot, runResearchLoop]);

  async function startResearch(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const targetCount = Math.max(
      1,
      Math.min(50, Math.round(Number(targetQualifiedCount) || 1)),
    );
    setBusy("research-create");
    setError(null);
    setNotice(null);
    setQueueView("current");

    try {
      const response = await fetch("/api/research/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetCount }),
      });
      const payload = (await response.json()) as { job?: ResearchJob; error?: string };
      if (!response.ok || !payload.job) {
        throw new Error(payload.error || "Could not create the research job");
      }
      window.localStorage.setItem(ACTIVE_RESEARCH_KEY, payload.job.id);
      setActiveJob(payload.job);
      setCurrentLeads([]);
      setSelectedId(null);
      setResearchJobs((current) => [
        payload.job!,
        ...current.filter((job) => job.id !== payload.job!.id),
      ]);
      setNotice("Research started. Results are saved as each business is checked.");
      setBusy(null);
      void runResearchLoop(payload.job.id);
    } catch (startError) {
      setError(startError instanceof Error ? startError.message : "Research could not start");
      setBusy(null);
    }
  }

  async function openSavedSearch(job: ResearchJob) {
    pollGenerationRef.current += 1;
    pollingJobRef.current = null;
    window.localStorage.setItem(ACTIVE_RESEARCH_KEY, job.id);
    setQueueView("current");
    setBusy("research-load");
    setError(null);
    try {
      const snapshot = await loadResearchSnapshot(job.id);
      setBusy(null);
      if (snapshot.job.status === "running") void runResearchLoop(job.id);
    } catch (openError) {
      setError(openError instanceof Error ? openError.message : "Saved search could not load");
      setBusy(null);
    }
  }

  async function stopResearch() {
    if (!activeJob || activeJob.status !== "running") return;
    const jobId = activeJob.id;
    pollGenerationRef.current += 1;
    pollingJobRef.current = null;
    setBusy("research-stop");
    try {
      const response = await fetch(
        `/api/research/jobs?id=${encodeURIComponent(jobId)}`,
        { method: "DELETE" },
      );
      const payload = (await response.json()) as { job?: ResearchJob; error?: string };
      if (!response.ok || !payload.job) {
        throw new Error(payload.error || "Could not stop research");
      }
      await loadResearchSnapshot(jobId);
      await loadResearchJobs();
      setNotice(researchCompletionNotice(payload.job));
    } catch (stopError) {
      setError(stopError instanceof Error ? stopError.message : "Research could not stop");
    } finally {
      setBusy(null);
    }
  }

  function beginNewSearch() {
    if (activeJob?.status === "running") return;
    pollGenerationRef.current += 1;
    pollingJobRef.current = null;
    window.localStorage.removeItem(ACTIVE_RESEARCH_KEY);
    setActiveJob(null);
    setCurrentLeads([]);
    setSelectedId(null);
    setQueueView("current");
    setError(null);
    setNotice("Clean opportunity queue ready. Previous searches and saved leads were kept.");
  }

  async function runAction(id: string, action: LeadAction, input: LeadActionInput = {}) {
    setBusy(`${id}:${action}`);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch("/api/leads/action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, action, ...input }),
      });
      const payload = (await response.json()) as {
        lead?: Lead;
        warning?: string | null;
        error?: string;
      };
      if (!response.ok || !payload.lead) {
        throw new Error(payload.error || "Action did not complete");
      }
      setLeads((current) => mergeLeadRecords(current, [payload.lead!]));
      setSavedLaunch((current) => {
        const savedLeads = mergeSavedForLaunchRecords(current.leads, [payload.lead!]);
        return { leads: savedLeads, count: savedLeads.length };
      });
      setCurrentLeads((current) =>
        current.map((lead) => lead.id === id
          ? { ...payload.lead!, researchStatus: lead.researchStatus, researchError: lead.researchError }
          : lead),
      );
      setSelectedId(id);
      setNotice(payload.warning || actionNotice(action));
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "Action failed");
    } finally {
      setBusy(null);
    }
  }

  async function verifyIntegrations() {
    setBusy("integrations");
    setError(null);
    setNotice(null);
    try {
      const response = await fetch("/api/integrations", { method: "POST" });
      const payload = (await response.json()) as { checks?: IntegrationChecks; error?: string };
      if (!response.ok || !payload.checks) {
        throw new Error(payload.error || "Could not verify integrations");
      }
      setChecks(payload.checks);
      const connected = Object.values(payload.checks).filter((check) => check.ok).length;
      setNotice(`Verification complete: ${connected} of 4 integrations are ready.`);
    } catch (checkError) {
      setError(checkError instanceof Error ? checkError.message : "Verification failed");
    } finally {
      setBusy(null);
    }
  }

  const combinedLeads = useMemo(
    () => mergeLeadRecords(leads, currentLeads),
    [currentLeads, leads],
  );
  const currentLeadIds = useMemo(
    () => new Set(currentLeads.map((lead) => lead.id)),
    [currentLeads],
  );
  const visibleLeads = useMemo(() => {
    if (queueView === "launch") return savedLaunch.leads;
    if (queueView === "history") {
      return combinedLeads.filter((lead) => !currentLeadIds.has(lead.id));
    }
    return currentLeads;
  }, [combinedLeads, currentLeadIds, currentLeads, queueView, savedLaunch.leads]);
  const selected = visibleLeads.find((lead) => lead.id === selectedId) ?? visibleLeads[0] ?? null;
  const stats = useMemo(() => ({
    total: combinedLeads.filter((lead) => lead.stage !== "rejected").length,
    saved: savedLaunch.count,
    sent: combinedLeads.filter((lead) => ["sending", "sent", "replied", "building", "concept_ready"].includes(lead.stage)).length,
    replies: combinedLeads.filter((lead) => ["replied", "building", "concept_ready"].includes(lead.stage)).length,
    concepts: combinedLeads.filter((lead) => lead.stage === "concept_ready").length,
  }), [combinedLeads, savedLaunch.count]);
  const runningJob = activeJob?.status === "running";
  const researchProgress = activeJob
    ? Math.min(100, Math.round((activeJob.qualifiedCount / activeJob.targetCount) * 100))
    : 0;

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div>
          <div className="brand-lockup">
            <span className="brand-mark">A</span>
            <div><strong>Amal AI Studio</strong><span>Private acquisition OS</span></div>
          </div>
          <nav className="side-nav" aria-label="Dashboard navigation">
            <button className={queueView === "current" ? "active" : ""} onClick={() => setQueueView("current")} type="button"><span>01</span> Current search</button>
            <button className={queueView === "history" ? "active" : ""} onClick={() => setQueueView("history")} type="button"><span>02</span> Search history <em>{researchJobs.length}</em></button>
            <button className={queueView === "launch" ? "active" : ""} onClick={() => setQueueView("launch")} type="button"><span>03</span> Launch list <em>{stats.saved}</em></button>
            <a href="/usage"><span>04</span> AI usage</a>
          </nav>
        </div>
        <div>
          <div className="integration-stack">
            <Integration label="AI engine" active={integrations.openai} fallback="Fallback" />
            <Integration label="Lead search" active={checks?.googlePlaces.ok ?? integrations.googlePlaces} fallback="Setup" />
            <Integration label="PageSpeed" active={checks?.pageSpeed.ok ?? integrations.pageSpeed} fallback="Setup" />
            <Integration label="Gmail API" active={checks?.gmail.ok ?? integrations.gmail} fallback="Setup" />
            <Integration label="Outreach" active={checks?.outreach.ok ?? integrations.outreachReady} fallback="Paused" />
            <button className="integration-check-button" disabled={busy === "integrations"} onClick={() => void verifyIntegrations()} type="button">
              {busy === "integrations" ? "Checking…" : "Verify connections"}
            </button>
          </div>
          <div className="owner-card">
            <span className="owner-avatar">{ownerName.slice(0, 1).toUpperCase()}</span>
            <div><strong>{ownerName}</strong><span>{localMode ? "Local owner mode" : "Verified owner"}</span></div>
          </div>
        </div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div>
            <p className="overline">AMAL AI / RESEARCH DESK</p>
            <h1>Building What Others Can’t Imagine.</h1>
            <p className="topbar-copy">Set the result you need. Research discovers, deduplicates, and checks businesses while preserving every qualified opportunity for launch.</p>
          </div>
          <span className="system-live"><i /> Owner only</span>
        </header>

        <section className="research-console" aria-label="Research controls">
          <div className="research-console-heading">
            <div><span>QUALIFIED RESEARCH</span><h2>One target. A resumable search.</h2></div>
            <small>Research only · no draft is written · no email is sent</small>
          </div>

          {!activeJob ? (
            <form className="research-command-row" onSubmit={startResearch}>
              <label>
                <span>Qualified opportunities to find</span>
                <input min="1" max="50" step="1" type="number" value={targetQualifiedCount} onChange={(event) => setTargetQualifiedCount(event.target.value)} required />
                <small>AI chooses safe markets and stops at the exact qualified target.</small>
              </label>
              <button disabled={busy !== null} type="submit">{busy === "research-create" ? "Preparing…" : "Start research"}<b>↗</b></button>
            </form>
          ) : (
            <div className="research-summary">
              <div className="research-summary-copy">
                <span className={`research-state state-${activeJob.status}`}>{activeJob.status}</span>
                <div><strong>{activeJob.plan.title}</strong><p>{currentMarket(activeJob)}</p></div>
                <b>{activeJob.qualifiedCount} / {activeJob.targetCount}</b>
              </div>
              <div className="research-progress-track"><span style={{ width: `${researchProgress}%` }} /></div>
              <div className="research-counter-grid">
                <ResearchCounter label="Raw" value={activeJob.rawCount} />
                <ResearchCounter label="Unique" value={activeJob.uniqueCount} />
                <ResearchCounter label="Checked" value={activeJob.checkedCount} />
                <ResearchCounter label="Qualified" value={activeJob.qualifiedCount} />
                <ResearchCounter label="Duplicates" value={activeJob.duplicateCount} />
                <ResearchCounter label="Errors" value={activeJob.failedCount} />
              </div>
              {(activeJob.stopReason || activeJob.lastError) && (
                <p className="research-status-line">
                  {activeJob.status === "partial" ? "Partial result — " : ""}
                  {activeJob.stopReason || activeJob.lastError}
                </p>
              )}
              <div className="research-actions">
                {runningJob ? (
                  <>
                    <button disabled={busy === "research"} onClick={() => void runResearchLoop(activeJob.id)} type="button">Resume saved search</button>
                    <button disabled={busy === "research-stop"} onClick={() => void stopResearch()} type="button">{busy === "research-stop" ? "Stopping…" : "Stop safely"}</button>
                  </>
                ) : (
                  <button onClick={beginNewSearch} type="button">New search</button>
                )}
              </div>
            </div>
          )}
        </section>

        {notice && <div className="notice" role="status">{notice}</div>}
        {error && <div className="error-notice" role="alert">{error}</div>}

        {queueView === "history" && researchJobs.length > 0 && (
          <section className="research-history-list" aria-label="Saved research runs">
            <div className="panel-heading"><div><span>SAVED RUNS</span><h2>Research history</h2></div><small>{researchJobs.length} runs</small></div>
            <div>
              {researchJobs.map((job) => (
                <button key={job.id} onClick={() => void openSavedSearch(job)} type="button">
                  <span className={`research-state state-${job.status}`}>{job.status}</span>
                  <strong>{job.qualifiedCount} / {job.targetCount} qualified</strong>
                  <small>{formatResearchDate(job.createdAt)} · {job.uniqueCount} unique · {job.checkedCount} checked</small>
                  <b>{job.status === "running" ? "Resume saved search" : "Open results"} ↗</b>
                </button>
              ))}
            </div>
          </section>
        )}

        <section className="launch-mode-banner" aria-label="Launch preparation status">
          <span>SENDING PAUSED</span>
          <div><h2>{stats.saved} suitable {stats.saved === 1 ? "client" : "clients"} saved for launch</h2><p>Research and manual review are separate from outreach. Nothing is sent automatically.</p></div>
          <button onClick={() => setQueueView("launch")} type="button">Review launch list ↗</button>
        </section>

        <section className="metric-row" aria-label="Pipeline totals">
          <Metric value={stats.total} label="leads found" />
          <Metric value={stats.saved} label="saved for launch" accent />
          <Metric value={stats.sent} label="emails sent" />
          <Metric value={stats.replies} label="replies" />
          <Metric value={stats.concepts} label="concepts ready" />
        </section>

        {loading ? (
          <div className="empty-state"><span>Loading research…</span></div>
        ) : visibleLeads.length === 0 ? (
          <div className="empty-state"><span>01</span><h2>{queueView === "current" ? "Start a clean research run." : "No opportunities in this view."}</h2><p>Qualified businesses remain saved across searches. Research never drafts or sends outreach.</p></div>
        ) : (
          <div className="dashboard-grid">
            <section className="lead-list-panel">
              <div className="panel-heading">
                <div><span>{queueView === "launch" ? "LAUNCH LIST" : queueView === "history" ? "PAST OPPORTUNITIES" : "CURRENT RESULTS"}</span><h2>Opportunity queue</h2></div>
                <div className="panel-heading-actions"><small>{visibleLeads.length} records</small>{queueView === "current" && <button className="new-queue-button" disabled={runningJob} onClick={beginNewSearch} type="button">New search</button>}</div>
              </div>
              <div className="lead-list">
                {visibleLeads.map((lead) => (
                  <button className={`lead-row ${selected?.id === lead.id ? "selected" : ""}`} key={lead.id} onClick={() => setSelectedId(lead.id)} type="button">
                    <span className="lead-monogram">{lead.name.slice(0, 2).toUpperCase()}</span>
                    <span className="lead-main"><strong>{lead.name}</strong><small>{lead.industry} · {shortLocation(lead.location)}</small></span>
                    <StagePill stage={lead.stage} demo={lead.source === "demo"} />
                    <span className={`score-mini ${lead.audit ? "ready" : ""}`}>{lead.audit?.score ?? "—"}</span>
                  </button>
                ))}
              </div>
            </section>
            {selected && <LeadDetail busy={busy} lead={selected} launchEnabled={integrations.launchEnabled} outreachReady={integrations.outreachReady} onAction={runAction} />}
          </div>
        )}
      </section>
    </main>
  );
}

function ResearchCounter({ label, value }: { label: string; value: number }) {
  return <div><strong>{value}</strong><span>{label}</span></div>;
}

function Integration({ label, active, fallback }: { label: string; active: boolean; fallback: string }) {
  return <div className={active ? "connected" : ""}><i /><span>{label}</span><b>{active ? "Live" : fallback}</b></div>;
}

function Metric({ value, label, accent = false }: { value: number; label: string; accent?: boolean }) {
  return <div className={accent ? "accent" : ""}><strong>{String(value).padStart(2, "0")}</strong><span>{label}</span></div>;
}

function mergeLeadRecords<T extends Lead>(current: T[], incoming: Lead[]): T[] {
  const merged = new Map<string, Lead>(current.map((lead) => [lead.id, lead]));
  incoming.forEach((lead) => merged.set(lead.id, lead));
  return Array.from(merged.values()) as T[];
}

function mergeSavedForLaunchRecords(current: Lead[], incoming: Lead[]): Lead[] {
  const merged = new Map(current.map((lead) => [lead.id, lead]));
  incoming.forEach((lead) => {
    if (lead.savedForLaunch) merged.set(lead.id, lead);
    else merged.delete(lead.id);
  });
  return Array.from(merged.values());
}

function currentMarket(job: ResearchJob): string {
  const search = job.plan.searches[Math.min(job.searchIndex, job.plan.searches.length - 1)];
  return search ? `${search.query} · ${search.location}` : "Search plan complete";
}

function researchCompletionNotice(job: ResearchJob): string {
  if (job.status === "complete") return `Target reached: ${job.qualifiedCount} qualified opportunities were saved. Nothing was sent.`;
  if (job.status === "partial") return `Research saved ${job.qualifiedCount} of ${job.targetCount} qualified opportunities before reaching a safe limit. Nothing was sent.`;
  if (job.status === "cancelled") return `Research stopped safely. ${job.qualifiedCount} qualified opportunities were kept.`;
  return `Research ended with ${job.qualifiedCount} qualified opportunities saved. Nothing was sent.`;
}

function formatResearchDate(value: string): string {
  try {
    return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(value));
  } catch {
    return value;
  }
}

function wait(milliseconds: number) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function actionNotice(action: LeadAction): string {
  const notices: Record<LeadAction, string> = {
    analyze: "Fit check complete. Complex portals, booking systems, and oversized websites are excluded automatically.",
    draft: "The personalized message is ready for owner review.",
    find_email: "Public business email check complete.",
    set_email: "The verified public business email has been saved.",
    approve: "Draft approved and saved. Sending remains locked until launch.",
    save_for_launch: "Qualified client saved for launch. No message was sent.",
    remove_from_launch: "Client removed from the launch list. Its research remains in the archive.",
    send: "Message processed and recorded in the pipeline.",
    reply: "Positive reply recorded manually. The internal concept can now be generated.",
    build: "Internal website concept generated. It has not been deployed or delivered.",
    unsubscribe: "Address added to the suppression list and will not be used again.",
    reject: "Opportunity moved to the archive.",
  };
  return notices[action];
}

function shortLocation(value: string): string {
  return value.split(",")[0] || value;
}
