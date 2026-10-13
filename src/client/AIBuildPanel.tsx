import { useEffect, useRef, useState } from "react";
import { ArrowUp, Check, LoaderCircle, Sparkles, X } from "lucide-react";
import type { AIGeneration, AIGenerationProgress } from "../shared/types";
import { newerGeneration } from "./ai-progress";
import { api, watchGeneration } from "./store";

const activeStates = ["queued", "designing", "checking", "repairing"];
const stages: Record<string, string> = {
  queued: "Getting ready",
  designing: "Designing the model",
  checking: "Checking the fit",
  repairing: "Adjusting the design",
};
export default function AIBuildPanel({
  world,
  onClose,
  onPreview,
}: {
  world: string;
  onClose: () => void;
  onPreview: (draft: AIGeneration | null) => void;
}) {
  const [jobs, setJobs] = useState<AIGeneration[]>([]);
  const [job, setJob] = useState<AIGeneration | null>(null);
  const [preview, setPreview] = useState<AIGeneration | null>(null);
  const [prompt, setPrompt] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [applying, setApplying] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [available, setAvailable] = useState<boolean | null>(null);
  const latest = useRef<AIGeneration | null>(null);
  const mounted = useRef(true);
  const log = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const submission = useRef(false);
  const busy = !!job && activeStates.includes(job.status);
  const drawing = busy && job?.preview?.parts.length ? job : preview;

  function receive(row: AIGeneration | AIGenerationProgress) {
    const previous = latest.current;
    if (
      !mounted.current ||
      previous?.id !== row.id ||
      !newerGeneration(previous, row)
    )
      return;
    const next = { ...previous, ...row };
    latest.current = next;
    setJob(next);
    setJobs((all) => all.map((r) => (r.id === next.id ? next : r)));
    if (next.status === "ready") setPreview(next);
    if (next.status === "accepted") setPreview(null);
    if (next.status === "cancelled")
      setPreview((prior) => (prior?.id === next.id ? null : prior));
  }
  useEffect(() => {
    mounted.current = true;
    void Promise.all([
      api<AIGeneration[]>(`/worlds/${world}/ai`),
      api<{ available: boolean }>("/ai/config"),
    ])
      .then(([rows, config]) => {
        if (!mounted.current) return;
        setAvailable(config.available);
        setJobs(rows);
        const current = rows.at(-1) || null;
        latest.current = current;
        setJob(current);
        const lastApplied = rows.map((r) => r.status).lastIndexOf("accepted");
        setPreview(
          rows
            .slice(lastApplied + 1)
            .filter((r) => r.status === "ready")
            .at(-1) || null,
        );
      })
      .catch((e) => {
        if (mounted.current) setError(e.message);
      })
      .finally(() => {
        if (mounted.current) setLoading(false);
      });
    return () => {
      mounted.current = false;
      onPreview(null);
    };
  }, [world, onPreview]);
  useEffect(() => {
    onPreview(drawing);
  }, [drawing, onPreview]);
  useEffect(() => {
    const update = () =>
      setElapsed(
        job
          ? Math.max(
              0,
              Math.floor(
                (Date.now() -
                  Date.parse(
                    (job as AIGeneration & { created_at?: string })
                      .created_at || new Date().toISOString(),
                  )) /
                  1000,
              ),
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
    if (!job) return;
    let alive = true,
      stop: (() => void) | undefined;
    const refresh = () =>
      api<AIGeneration>(`/ai/generations/${job.id}`)
        .then((row) => {
          if (alive) receive(row);
        })
        .catch(() => {});
    void watchGeneration(job.id, (row) => {
      if (!alive) return;
      receive(row);
      if (["ready", "accepted", "failed", "cancelled"].includes(row.status))
        void refresh();
    })
      .then((off) => {
        if (alive) stop = off;
        else off();
      })
      .catch(() => {});
    // Claiming is idempotent across reloads/tabs. The Function owns its deadline.
    if (job.status === "queued")
      void api<AIGeneration>(`/ai/generations/${job.id}/run`, {
        method: "POST",
        signal: AbortSignal.timeout(175000),
      })
        .then((row) => {
          if (alive) receive(row);
        })
        .catch(() => {
          if (alive) void refresh();
        });
    const timer = setInterval(() => {
      if (latest.current && activeStates.includes(latest.current.status))
        void refresh();
    }, 5000);
    return () => {
      alive = false;
      stop?.();
      clearInterval(timer);
    };
  }, [job?.id]);

  async function send() {
    if (
      submission.current ||
      busy ||
      loading ||
      applying ||
      prompt.trim().length < 3
    )
      return;
    submission.current = true;
    setSubmitting(true);
    setError("");
    const id = crypto.randomUUID(),
      text = prompt.trim();
    try {
      const row = await api<AIGeneration>("/ai/generations", {
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
      if (!mounted.current) return;
      latest.current = row;
      setJob(row);
      setJobs((all) => [...all, row]);
      setPrompt("");
    } catch (e) {
      if (mounted.current) setError((e as Error).message);
    } finally {
      submission.current = false;
      if (mounted.current) setSubmitting(false);
    }
  }
  async function cancel() {
    if (!job) return;
    try {
      receive(
        await api<AIGeneration>(`/ai/generations/${job.id}/cancel`, {
          method: "POST",
        }),
      );
    } catch (e) {
      if (mounted.current) setError((e as Error).message);
    }
  }
  async function apply() {
    if (!preview || busy || applying) return;
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
      const row = await api<AIGeneration>(`/ai/generations/${preview.id}`);
      setJobs((all) => all.map((r) => (r.id === row.id ? row : r)));
      if (latest.current?.id === row.id) {
        latest.current = row;
        setJob(row);
      }
      setPreview(null);
      onPreview(null);
      composer.current?.focus();
    } catch (e) {
      if (mounted.current) setError((e as Error).message);
    } finally {
      if (mounted.current) setApplying(false);
    }
  }
  async function discard() {
    if (!preview || busy || applying) return;
    const id = preview.id;
    try {
      const row = await api<AIGeneration>(`/ai/generations/${id}/cancel`, {
        method: "POST",
      });
      if (!mounted.current) return;
      setJobs((all) => all.map((r) => (r.id === id ? row : r)));
      if (latest.current?.id === id) {
        latest.current = row;
        setJob(row);
      }
      setPreview(null);
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
            <div className="ai-message-label">You</div>
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
          <span>Previewing your draft</span>
          <div>
            <button
              className="primary-button"
              disabled={applying || submitting}
              onClick={() => void apply()}
            >
              {applying ? "Applying…" : "Apply to model"}
              <Check size={14} />
            </button>
            <button
              className="ai-secondary"
              disabled={applying || submitting}
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
          disabled={loading || applying}
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
            {busy
              ? "You can write your next idea while I work."
              : "Enter to send · Shift Enter for a new line"}
          </small>
          {busy ? (
            <button
              type="button"
              className="ai-secondary"
              onClick={() => void cancel()}
            >
              Stop
            </button>
          ) : (
            <button
              className="ai-send"
              aria-label="Send build request"
              disabled={
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
