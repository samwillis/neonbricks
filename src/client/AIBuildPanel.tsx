import { useEffect, useRef, useState } from "react";
import { ArrowUp, Check, LoaderCircle, Sparkles, X } from "lucide-react";
import type { AIGeneration } from "../shared/types";
import {
  activeAIStates as activeStates,
  conversationRows,
  conversationState,
} from "./ai-conversation";
import { api, watchConversation } from "./store";

const stages: Record<string, string> = {
  queued: "Getting ready",
  designing: "Designing the model",
  checking: "Checking the fit",
  repairing: "Adjusting the design",
};
export default function AIBuildPanel({
  world,
  guest,
  editable,
  onClose,
  onPreview,
}: {
  world: string;
  guest: string;
  editable: boolean;
  onClose: () => void;
  onPreview: (draft: AIGeneration | null) => void;
}) {
  const [jobs, setJobs] = useState<AIGeneration[]>([]);
  const { job, preview } = conversationState(jobs);
  const [prompt, setPrompt] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [applying, setApplying] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [available, setAvailable] = useState<boolean | null>(null);
  const mounted = useRef(true);
  const log = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const submission = useRef(false);
  const busy = !!job && activeStates.includes(job.status);
  const drawing = busy && job?.preview?.parts.length ? job : preview;

  useEffect(() => {
    mounted.current = true;
    let alive = true,
      stop: (() => void) | undefined;
    void api<{ available: boolean }>("/ai/config")
      .then((config) => {
        if (alive) setAvailable(config.available);
      })
      .catch((e) => {
        if (alive) setError(e.message);
      });
    void watchConversation(
      world,
      (rows) => {
        if (!alive) return;
        setJobs(conversationRows(rows));
        setLoading(false);
      },
      (message) => {
        if (alive) setError(message);
      },
    )
      .then((off) => {
        if (alive) stop = off;
        else off();
      })
      .catch((e) => {
        if (alive) setError(e.message);
      });
    return () => {
      alive = false;
      mounted.current = false;
      stop?.();
      onPreview(null);
    };
  }, [world, onPreview]);
  useEffect(() => {
    onPreview(drawing);
  }, [drawing, onPreview]);
  useEffect(() => {
    const update = () =>
      setElapsed(
        job?.created_at
          ? Math.max(
              0,
              Math.floor((Date.now() - Date.parse(job.created_at)) / 1000),
            )
          : 0,
      );
    update();
    if (!busy) return;
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [job?.id, busy]);
  useEffect(() => {
    log.current?.scrollTo({
      top: log.current.scrollHeight,
      behavior: "smooth",
    });
  }, [jobs.length, job?.status, error, preview?.id]);
  useEffect(() => {
    if (!job || !busy) return;
    // Any editor can resume a queued workshop request. One transactional claim
    // wins across devices; all rendering continues to come from the live query.
    if (job.status === "queued" && editable)
      void api(`/ai/generations/${job.id}/run`, {
        method: "POST",
        signal: AbortSignal.timeout(175000),
      }).catch(() => {});
    // Reads expire evicted work; HTTP responses never overwrite live snapshots.
    const timer = setInterval(() => {
      void api(`/ai/generations/${job.id}`).catch(() => {});
    }, 5000);
    return () => clearInterval(timer);
  }, [job?.id, job?.status === "queued", busy, editable]);

  async function send() {
    if (
      submission.current ||
      busy ||
      loading ||
      applying ||
      !editable ||
      !available ||
      prompt.trim().length < 3
    )
      return;
    submission.current = true;
    setSubmitting(true);
    setError("");
    const id = crypto.randomUUID(),
      text = prompt.trim();
    try {
      await api<AIGeneration>("/ai/generations", {
        method: "POST",
        body: JSON.stringify({
          id,
          prompt: text,
          target: world,
          ...(preview ? { source: preview.id } : {}),
        }),
      }).catch(async (e) => {
        try {
          return await api<AIGeneration>(`/ai/generations/${id}`);
        } catch {
          throw e;
        }
      });
      if (mounted.current) setPrompt("");
    } catch (e) {
      if (mounted.current) setError((e as Error).message);
    } finally {
      submission.current = false;
      if (mounted.current) setSubmitting(false);
    }
  }
  async function cancel() {
    if (!job || !editable) return;
    try {
      await api(`/ai/generations/${job.id}/cancel`, { method: "POST" });
    } catch (e) {
      if (mounted.current) setError((e as Error).message);
    }
  }
  async function apply() {
    if (!preview || busy || applying || !editable) return;
    setApplying(true);
    setError("");
    try {
      const result = await api<{ slug: string }>(
        `/ai/generations/${preview.id}/accept`,
        { method: "POST" },
      );
      if (!mounted.current) return;
      if (!preview.target) {
        location.assign(`/w/${result.slug}?ai=1&frame=1`);
        return;
      }
      composer.current?.focus();
    } catch (e) {
      if (mounted.current) setError((e as Error).message);
    } finally {
      if (mounted.current) setApplying(false);
    }
  }
  async function discard() {
    if (!preview || busy || applying || !editable) return;
    try {
      await api(`/ai/generations/${preview.id}/cancel`, { method: "POST" });
      if (!mounted.current) return;
      setError("");
      composer.current?.focus();
    } catch (e) {
      if (mounted.current) setError((e as Error).message);
    }
  }
  return (
    <aside
      className="ai-chat"
      aria-label="AI building chat"
      onKeyDown={(e) => e.stopPropagation()}
    >
      <div className="ai-chat-heading">
        <span>
          <Sparkles size={16} />
          Build with AI
        </span>
        <button
          className="icon-button"
          aria-label="Close AI chat"
          onClick={onClose}
        >
          <X size={17} />
        </button>
      </div>
      <div
        className="ai-chat-log"
        ref={log}
        role="log"
        aria-label="Build conversation"
      >
        {loading ? (
          <p className="ai-chat-empty">Opening the conversation…</p>
        ) : (
          !jobs.length && (
            <div className="ai-chat-empty">
              <h2>Keep shaping it.</h2>
              <p>
                Ask for a new detail, a different colour, or something entirely
                new.
              </p>
            </div>
          )
        )}
        {jobs.map((row) => (
          <div className="ai-exchange" key={row.id}>
            <div className="ai-message-label">
              <span
                className="ai-author-dot"
                style={{ background: row.author_color || "var(--green)" }}
              />
              {row.author_name || "Builder"}
              {row.author === guest ? " · you" : ""}
            </div>
            <p className="ai-user-message">{row.prompt}</p>
            <div className="ai-message-label ai-assistant-label">
              <Sparkles size={12} />
              neonbricks
            </div>
            {activeStates.includes(row.status) ? (
              <div className="ai-live-message">
                <span>
                  <LoaderCircle size={14} className="spin" />
                  {row.activity || stages[row.status]}
                </span>
                {row.id === job?.id && (
                  <small>
                    {elapsed}s
                    {row.attempt > 1 ? ` · design pass ${row.attempt}` : ""}
                  </small>
                )}
                <p>
                  {row.preview?.parts.length
                    ? "A draft is taking shape on the canvas."
                    : "Your current model stays safe while I work."}
                </p>
              </div>
            ) : row.status === "failed" ? (
              <p className="ai-error">
                {row.error || "This build was interrupted. Please try again."}
              </p>
            ) : row.status === "cancelled" ? (
              <p className="ai-chat-note">
                Draft set aside. The workshop is unchanged.
              </p>
            ) : (
              <>
                <p className="ai-assistant-message">
                  {row.blueprint?.summary &&
                  row.blueprint.summary !== "The current workshop model."
                    ? row.blueprint.summary
                    : row.status === "accepted"
                      ? "Your changes are applied."
                      : "Your updated draft is ready."}
                </p>
                <span className="ai-chat-result">
                  {row.status === "accepted" ? (
                    <>
                      <Check size={12} />
                      Applied to the model
                    </>
                  ) : (
                    `${row.parts.length || row.preview?.parts.length || 0} pieces · draft ready`
                  )}
                </span>
              </>
            )}
          </div>
        ))}
      </div>
      {preview && !busy && (
        <div className="ai-chat-review">
          <span>Previewing the workshop draft</span>
          <div>
            <button
              className="primary-button"
              disabled={applying || submitting || !editable}
              onClick={() => void apply()}
            >
              {applying ? "Applying…" : "Apply to model"}
              <Check size={14} />
            </button>
            <button
              className="ai-secondary"
              disabled={applying || submitting || !editable}
              onClick={() => void discard()}
            >
              Keep current
            </button>
          </div>
        </div>
      )}
      {error && (
        <p className="ai-error ai-chat-error" role="alert">
          {error}
        </p>
      )}
      {available === false && (
        <p className="ai-error ai-chat-error">
          AI building is not available right now.
        </p>
      )}
      <form
        className="ai-composer"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <label className="sr-only" htmlFor="ai-chat-prompt">
          Ask AI to change the model
        </label>
        <textarea
          id="ai-chat-prompt"
          ref={composer}
          rows={3}
          maxLength={1200}
          placeholder={
            preview
              ? "Make this draft a little more…"
              : "What would you like to change?"
          }
          value={prompt}
          disabled={loading || applying || !editable}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (
              e.key === "Enter" &&
              !e.shiftKey &&
              !e.nativeEvent.isComposing
            ) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <div className="ai-composer-actions">
          <small>
            {!editable
              ? "You can follow this workshop’s AI builds."
              : busy
                ? "You can write your next idea while I work."
                : "Enter to send · Shift Enter for a new line"}
          </small>
          {busy ? (
            <button
              type="button"
              className="ai-secondary"
              disabled={!editable}
              onClick={() => void cancel()}
            >
              Stop
            </button>
          ) : (
            <button
              className="ai-send"
              aria-label="Send build request"
              disabled={
                !editable ||
                !available ||
                loading ||
                submitting ||
                applying ||
                prompt.trim().length < 3
              }
            >
              {submitting ? (
                <LoaderCircle size={16} className="spin" />
              ) : (
                <ArrowUp size={18} />
              )}
            </button>
          )}
        </div>
      </form>
    </aside>
  );
}
