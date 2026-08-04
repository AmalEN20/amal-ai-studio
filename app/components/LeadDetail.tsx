"use client";

import { useState, type CSSProperties } from "react";
import type { Lead, LeadStage } from "@/lib/types";
import {
  PIPELINE,
  STAGE_LABELS,
  StagePill,
  isLaunchReadyLead,
  type LeadAction,
  type LeadActionInput,
} from "./lead-shared";

export function LeadDetail({
  lead,
  busy,
  launchEnabled,
  outreachReady,
  onAction,
}: {
  lead: Lead;
  busy: string | null;
  launchEnabled: boolean;
  outreachReady: boolean;
  onAction: (id: string, action: LeadAction, input?: LeadActionInput) => Promise<void>;
}) {
  const pipelineStage = lead.stage === "approved"
    ? "drafted"
    : lead.stage === "sending"
      ? "sent"
      : lead.stage;
  const currentIndex = PIPELINE.indexOf(pipelineStage);
  const action = nextAction(lead.stage);
  const isBusy = lead.stage === "sending" || busy === "research" || busy === "auto-qualify" || (busy?.startsWith(`${lead.id}:`) ?? false);

  return (
    <section className="lead-detail-panel">
      <div className="detail-header">
        <div>
          <p>{lead.source === "demo" ? "DEMO LEAD" : "LIVE LEAD"} / {lead.industry.toUpperCase()}</p>
          <h2>{lead.name}</h2>
          <span>{lead.location}</span>
        </div>
        {lead.audit ? (
          <div className="opportunity-score" style={{ "--score": `${lead.audit.score * 3.6}deg` } as CSSProperties}>
            <strong>{lead.audit.score}</strong><span>audit</span>
          </div>
        ) : (
          <div className="opportunity-score empty"><strong>—</strong><span>audit</span></div>
        )}
      </div>

      {lead.savedForLaunch && (
        <div className="saved-for-launch-badge">
          <span>{isLaunchReadyLead(lead) ? "✓ SAVED FOR LAUNCH" : "RESEARCH CANDIDATE"}</span>
          <small>
            {isLaunchReadyLead(lead)
              ? "Will be checked again before the final message is prepared"
              : "Retained in the database, but the objective V1 scope checks have not passed"}
          </small>
        </div>
      )}

      <div className="contact-strip">
        <span><b>WEB</b>{lead.website ? displayDomain(lead.website) : "No website found"}</span>
        <span><b>EMAIL</b>{lead.email || "Lookup pending"}</span>
        <span><b>PROOF</b>{lead.rating ? `${lead.rating} / ${lead.reviewCount ?? 0} reviews` : "Not checked"}</span>
      </div>

      <ContactEmailEditor
        findBusy={lead.stage === "sending" || busy === `${lead.id}:find_email`}
        saveBusy={lead.stage === "sending" || busy === `${lead.id}:set_email`}
        key={`${lead.id}:${lead.email}`}
        lead={lead}
        onFind={() => onAction(lead.id, "find_email")}
        onSave={(email) => onAction(lead.id, "set_email", { email })}
      />

      <div className="pipeline-track">
        {PIPELINE.map((stage, index) => (
          <div className={index <= currentIndex ? "complete" : ""} key={stage}>
            <i>{index < currentIndex ? "✓" : index + 1}</i>
            <span>{STAGE_LABELS[stage]}</span>
          </div>
        ))}
      </div>

      {!lead.audit ? (
        <section className="detail-card audit-prompt">
          <div className="card-number">01</div>
          <div>
            <span className="eyebrow">WEBSITE OPPORTUNITY</span>
            <h3>Should the studio contact this business?</h3>
            <p>AI checks the website, mobile performance, trust signals, and clarity of the next step.</p>
          </div>
        </section>
      ) : (
        <section className="detail-card audit-card">
          <div className="card-heading">
            <div><span className="eyebrow">AI AUDIT</span><h3>{lead.audit.summary}</h3></div>
            <div className="audit-heading-actions">
              <StagePill stage={lead.stage} demo={lead.analysisProvider === "fallback"} />
              {!['sending', 'sent', 'replied', 'building', 'concept_ready', 'unsubscribed'].includes(lead.stage) && (
                <button className="copy-button" disabled={isBusy} onClick={() => onAction(lead.id, "analyze")} type="button">Re-check fit</button>
              )}
            </div>
          </div>
          {lead.audit.serviceFit && (
            <div className={`fit-decision fit-${lead.audit.serviceFit}`}>
              <span>{lead.audit.serviceFit === "ideal" ? "STUDIO V1 FIT" : "NOT A V1 FIT"}</span>
              <b>{lead.audit.positioningAngle}</b>
              {lead.audit.complexitySignals?.map((signal) => <small key={signal}>{signal}</small>)}
            </div>
          )}
          <div className="audit-columns">
            <div><b>What is weak</b>{lead.audit.weaknesses.map((item) => <p key={item}><i>−</i>{item}</p>)}</div>
            <div><b>What the studio can improve</b>{lead.audit.opportunities.map((item) => <p key={item}><i>+</i>{item}</p>)}</div>
          </div>
          {Object.values(lead.audit.performance).some((value) => value !== null) && (
            <div className="performance-row">
              <span>Mobile performance <b>{lead.audit.performance.performance ?? "—"}</b></span>
              <span>Accessibility <b>{lead.audit.performance.accessibility ?? "—"}</b></span>
              <span>SEO <b>{lead.audit.performance.seo ?? "—"}</b></span>
            </div>
          )}
        </section>
      )}

      {lead.outreach && (
        <section className="detail-card outreach-card">
          <div className="card-heading">
            <div><span className="eyebrow">PERSONALIZED OUTREACH</span><h3>{lead.outreach.subject}</h3></div>
            <button
              className="copy-button"
              onClick={() => navigator.clipboard.writeText(`Subject: ${lead.outreach!.subject}\n\n${lead.outreach!.body}`)}
              type="button"
            >Copy</button>
          </div>
          <pre>{lead.outreach.body}</pre>
          <div className="sending-line">
            <span>From <b>your verified Gmail sender</b></span>
            <span>{lead.sendProvider === "gmail" ? "Sent with Gmail API" : lead.sendProvider === "demo" ? "Simulated send" : lead.savedForLaunch ? "Saved — sending paused" : "Waiting for approval"}</span>
          </div>
        </section>
      )}

      {lead.site && <SitePreview lead={lead} />}

      <div className="action-bar">
        <div>
          <span>NEXT ACTION</span>
          <p>{lead.stage === "approved" && !launchEnabled ? "Saved for launch. Sending is locked until you explicitly start outreach." : nextActionDescription(lead.stage)}</p>
        </div>
        <div className="action-buttons">
          {lead.audit && (lead.savedForLaunch || lead.audit.serviceFit === "ideal") && !['rejected', 'unsubscribed'].includes(lead.stage) && (
            <button
              className="ghost-button save-launch-button"
              disabled={isBusy}
              onClick={() => onAction(lead.id, lead.savedForLaunch ? "remove_from_launch" : "save_for_launch")}
              type="button"
            >
              {lead.savedForLaunch ? "Remove from launch" : "Save for launch"}
            </button>
          )}
          {['sent', 'replied'].includes(lead.stage) && (
            <button className="ghost-button optout-button" disabled={isBusy} onClick={() => onAction(lead.id, "unsubscribe")} type="button">Record opt-out</button>
          )}
          {!['rejected', 'unsubscribed', 'concept_ready'].includes(lead.stage) && (
            <button className="ghost-button" disabled={isBusy} onClick={() => onAction(lead.id, "reject")} type="button">Archive</button>
          )}
          {action && (
            <button
              className="primary-action"
              disabled={isBusy || (action.key === "send" && (!launchEnabled || !outreachReady || !lead.email))}
              onClick={() => onAction(lead.id, action.key)}
              title={action.key === "send" && !launchEnabled ? "Sending is intentionally paused until launch" : action.key === "send" && !outreachReady ? "Sending unlocks after the public PO Box address is added" : undefined}
              type="button"
            >
              {isBusy
                ? "Working…"
                : action.key === "send" && !lead.email
                  ? "Add business email"
                  : action.key === "send" && !launchEnabled
                    ? "Paused until launch"
                  : action.key === "send" && !outreachReady
                    ? "PO Box required"
                    : action.label}<b>↗</b>
            </button>
          )}
        </div>
      </div>
    </section>
  );
}

function ContactEmailEditor({
  lead,
  findBusy,
  saveBusy,
  onFind,
  onSave,
}: {
  lead: Lead;
  findBusy: boolean;
  saveBusy: boolean;
  onFind: () => Promise<void>;
  onSave: (email: string) => Promise<void>;
}) {
  const [email, setEmail] = useState(lead.email);
  const unchanged = email.trim().toLowerCase() === lead.email.trim().toLowerCase();

  return (
    <form
      className="contact-email-editor"
      onSubmit={(event) => {
        event.preventDefault();
        void onSave(email);
      }}
    >
      <div className="contact-email-copy">
        <span>PUBLIC BUSINESS EMAIL</span>
        <p>The system uses only a public address from the official website and never guesses an email.</p>
      </div>
      <label>
        <span className="sr-only">Public business email</span>
        <input
          autoComplete="off"
          inputMode="email"
          onChange={(event) => setEmail(event.target.value)}
          placeholder="hello@business.com"
          type="email"
          value={email}
        />
      </label>
      <div className="contact-email-actions">
        {!lead.email && (
          <button className="find-email-button" disabled={findBusy || saveBusy || !lead.website} onClick={() => void onFind()} type="button">
            {findBusy ? "Searching…" : "Find public email"}
          </button>
        )}
        <button disabled={findBusy || saveBusy || unchanged || !email.trim()} type="submit">
          {saveBusy ? "Saving…" : lead.email ? "Update" : "Save manually"}
        </button>
      </div>
    </form>
  );
}

function SitePreview({ lead }: { lead: Lead }) {
  const site = lead.site!;
  const style = {
    "--site-bg": site.design.background,
    "--site-surface": site.design.surface,
    "--site-text": site.design.text,
    "--site-muted": site.design.muted,
    "--site-accent": site.design.accent,
  } as CSSProperties;
  return (
    <section className="site-preview-card">
      <div className="preview-toolbar"><span><i /><i /><i /></span><b>PREVIEW / {site.design.themeName}</b></div>
      <div className="landing-preview" style={style}>
        <nav><strong>{lead.name}</strong><span>Services&nbsp;&nbsp; About&nbsp;&nbsp; Contact</span></nav>
        <div className="preview-hero">
          <p>{site.copy.eyebrow}</p>
          <h3>{site.copy.headline}</h3>
          <span>{site.copy.subheadline}</span>
          <button type="button">{site.copy.primaryCta} ↗</button>
        </div>
        <div className="preview-services">
          {site.copy.services.map((service, index) => (
            <article key={service.title}><b>0{index + 1}</b><h4>{service.title}</h4><p>{service.description}</p></article>
          ))}
        </div>
      </div>
    </section>
  );
}

function nextAction(stage: LeadStage): { key: LeadAction; label: string } | null {
  if (stage === "discovered") return { key: "analyze", label: "Run AI audit" };
  if (stage === "qualified") return { key: "draft", label: "Write outreach" };
  if (stage === "drafted") return { key: "approve", label: "Approve draft" };
  if (stage === "approved") return { key: "send", label: "Send email" };
  if (stage === "sent") return { key: "reply", label: "Record positive reply" };
  if (stage === "replied") return { key: "build", label: "Generate concept" };
  return null;
}

function nextActionDescription(stage: LeadStage): string {
  if (stage === "discovered") return "Confirm this company fits our current website offer.";
  if (stage === "qualified") return "Turn the audit into a short, honest personalized email.";
  if (stage === "drafted") return "Review the message before anything can be sent.";
  if (stage === "approved") return "Send from your verified Gmail sender address.";
  if (stage === "sending") return "The Gmail send is in progress. Duplicate send actions are locked.";
  if (stage === "sent") return "Check Gmail manually. When a positive reply arrives, record it here.";
  if (stage === "replied") return "Create an internal premium website concept for owner review.";
  if (stage === "building") return "The internal website concept is being generated.";
  if (stage === "concept_ready") return "Internal concept ready for owner review. It has not been deployed or delivered.";
  if (stage === "unsubscribed") return "Suppressed permanently. This address must never be contacted again.";
  if (stage === "rejected") return "Archived or outside Studio V1 scope. No outreach will be created or sent.";
  return "This lead is outside the active pipeline.";
}

function displayDomain(value: string): string {
  try { return new URL(value).hostname.replace(/^www\./, ""); } catch { return value; }
}
