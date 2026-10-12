import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, Blocks, LoaderCircle, X } from "lucide-react";
import type { AIGeneration } from "../shared/types";
import { api, watchGeneration } from "./store";
import Scene from "./Scene";
import type { Theme } from "./theme";

const savedJob = "neon-bricks-ai-job";
const busyStates = ["queued", "designing", "checking", "repairing"];
const stages: Record<string, string> = {
  queued: "Getting ready…",
  designing: "Designing your model…",
  checking: "Checking the fit…",
  repairing: "Adjusting the build…",
};
const examples = [
  "A little forest lookout with a red roof",
  "A yellow exploration rover with chunky wheels",
  "A seaside lighthouse with a tiny keeper's house",
];
export default function AIBuildDialog({
  theme,
  onClose,
}: {
  theme: Theme;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [prompt, setPrompt] = useState("");
  const [job, setJob] = useState<AIGeneration | null>(null);
  const [error, setError] = useState("");
  const [available, setAvailable] = useState<boolean | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [restoring, setRestoring] = useState(true);
  const [accepting, setAccepting] = useState(false);
  const mounted = useRef(true);
  const currentJob = useRef<string | null>(null);
  const busy = !!job && busyStates.includes(job.status);
  const ready =
    !!job && ["ready", "accepted"].includes(job.status) && job.parts.length > 0;
  function receiveJob(row: AIGeneration) {
    if (mounted.current && currentJob.current === row.id) setJob(row);
  }
  function close() {
    if (!accepting) onClose();
  }
  useEffect(() => {
    mounted.current = true;
    dialog.current?.showModal();
    void api<{ available: boolean }>("/ai/config")
      .then((c) => {
        if (mounted.current) setAvailable(c.available);
      })
      .catch((e) => {
        if (mounted.current) setError(e.message);
      });
    const id = sessionStorage.getItem(savedJob);
    currentJob.current = id;
    if (id)
      void api<AIGeneration>(`/ai/generations/${id}`)
        .then((row) => {
          if (!mounted.current || currentJob.current !== id) return;
          setPrompt(row.prompt);
          if (row.status !== "cancelled") setJob(row);
          if (row.status === "queued") {
            void api<AIGeneration>(`/ai/generations/${row.id}/run`, {
              method: "POST",
              signal: AbortSignal.timeout(175_000),
            })
              .then(receiveJob)
              .catch(() => {});
          }
        })
        .catch((e: Error & { status?: number }) => {
          if (e.status === 404 && sessionStorage.getItem(savedJob) === id)
            sessionStorage.removeItem(savedJob);
          if (mounted.current && e.status !== 404) setError(e.message);
        })
        .finally(() => {
          if (mounted.current) setRestoring(false);
        });
    else setRestoring(false);
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!restoring)
      dialog.current?.querySelector<HTMLTextAreaElement>("textarea")?.focus();
  }, [restoring]);
  useEffect(() => {
    if (!job) return;
    let active = true;
    let unwatch: (() => void) | undefined;
    const refresh = () =>
      api<AIGeneration>(`/ai/generations/${job.id}`)
        .then((row) => {
          if (active) receiveJob(row);
        })
        .catch((e) => {
          if (active) setError(e.message);
        });
    void watchGeneration(job.id, (row) => {
      if (!active) return;
      setJob((previous) =>
        currentJob.current === row.id && previous?.id === row.id
          ? { ...previous, ...row }
          : previous,
      );
      if (["ready", "accepted", "failed", "cancelled"].includes(row.status))
        void refresh();
    })
      .then((stop) => {
        if (active) unwatch = stop;
        else stop();
      })
      .catch(() => {});
    // Realtime drives stage changes; bounded polling also detects an evicted
    // Function or a missed subscription event so the dialog cannot get stuck.
    const timer = setInterval(() => {
      if (busyStates.includes(job.status)) void refresh();
    }, 5000);
    return () => {
      active = false;
      unwatch?.();
      clearInterval(timer);
    };
  }, [job?.id, job?.status]);
  async function build() {
    if (
      busy ||
      submitting ||
      restoring ||
      accepting ||
      prompt.trim().length < 3
    )
      return;
    const id = crypto.randomUUID();
    currentJob.current = id;
    // Save before the request so closing or reloading during submission can
    // recover a reservation whose response was lost.
    sessionStorage.setItem(savedJob, id);
    setSubmitting(true);
    setJob(null);
    setError("");
    try {
      const row = await api<AIGeneration>("/ai/generations", {
        method: "POST",
        body: JSON.stringify({
          id,
          prompt: prompt.trim(),
        }),
      }).catch(async (e) => {
        // The reservation may have committed even if its response was lost.
        try {
          return await api<AIGeneration>(`/ai/generations/${id}`);
        } catch {
          throw e;
        }
      });
      receiveJob(row);
      void api<AIGeneration>(`/ai/generations/${row.id}/run`, {
        method: "POST",
        signal: AbortSignal.timeout(175_000),
      })
        .then(receiveJob)
        .catch(() => {
          void api<AIGeneration>(`/ai/generations/${row.id}`)
            .then(receiveJob)
            .catch((e) => {
              if (mounted.current && currentJob.current === id)
                setError(e.message);
            });
        });
    } catch (e) {
      if (mounted.current && currentJob.current === id)
        setError((e as Error).message);
    } finally {
      if (mounted.current) setSubmitting(false);
    }
  }
  async function cancel() {
    if (!job) return;
    const id = job.id;
    try {
      const row = await api<AIGeneration>(`/ai/generations/${id}/cancel`, {
        method: "POST",
      });
      receiveJob(row);
      if (sessionStorage.getItem(savedJob) === id)
        sessionStorage.removeItem(savedJob);
    } catch (e) {
      if (mounted.current && currentJob.current === id)
        setError((e as Error).message);
    }
  }
  async function accept() {
    if (!job || accepting) return;
    setAccepting(true);
    setError("");
    try {
      const world = await api<{ slug: string }>(
        `/ai/generations/${job.id}/accept`,
        { method: "POST" },
      );
      sessionStorage.removeItem(savedJob);
      location.assign(`/w/${world.slug}?frame=1`);
    } catch (e) {
      setError((e as Error).message);
      setAccepting(false);
    }
  }
  return (
    <dialog
      ref={dialog}
      className={`ai-dialog ${ready ? "has-preview" : ""}`}
      aria-labelledby="ai-title"
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          const rect = e.currentTarget.getBoundingClientRect();
          if (
            e.clientX < rect.left ||
            e.clientX > rect.right ||
            e.clientY < rect.top ||
            e.clientY > rect.bottom
          )
            close();
        }
      }}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <button
        className="modal-close"
        aria-label="Close AI builder"
        disabled={accepting}
        onClick={close}
      >
        <X size={18} />
      </button>
      <div className="ai-copy">
        <h2 id="ai-title">Build with AI</h2>
        <p className="ai-intro">Describe something you'd like to build.</p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void build();
          }}
        >
          <label className="sr-only" htmlFor="ai-prompt">
            What would you like to build?
          </label>
          <textarea
            id="ai-prompt"
            autoFocus
            rows={4}
            maxLength={1200}
            placeholder="A cosy cabin with a chimney, a red roof and a little pine tree…"
            value={prompt}
            disabled={busy || submitting || restoring || accepting}
            onChange={(e) => setPrompt(e.target.value)}
          />
          {!job && (
            <div className="ai-examples">
              {examples.map((example) => (
                <button
                  key={example}
                  type="button"
                  disabled={busy || submitting || restoring || accepting}
                  onClick={() => setPrompt(example)}
                >
                  {example}
                  <ArrowUpRight size={12} />
                </button>
              ))}
            </div>
          )}
          <div className="ai-status" role="status" aria-live="polite">
            {busy || submitting ? (
              <>
                <LoaderCircle size={16} className="spin" />
                <span>
                  {submitting ? "Getting ready…" : stages[job!.status]}
                </span>
              </>
            ) : ready ? (
              <span>{job!.parts.length} pieces · ready to make your own</span>
            ) : (
              <span>Small models, built from real pieces.</span>
            )}
          </div>
          {(error || job?.error) && (
            <p className="ai-error" role="alert">
              {error || job?.error}
            </p>
          )}
          {available === false && (
            <p className="ai-error">AI building is not available right now.</p>
          )}
          <div className="ai-actions">
            {busy ? (
              <button
                type="button"
                className="ai-secondary"
                onClick={() => void cancel()}
              >
                Cancel build
              </button>
            ) : (
              <button
                type="submit"
                className={ready ? "ai-secondary" : "primary-button"}
                disabled={
                  !available ||
                  restoring ||
                  submitting ||
                  accepting ||
                  prompt.trim().length < 3
                }
              >
                {ready || job ? "Build again" : "Build"}
                {!ready && <ArrowUpRight size={16} />}
              </button>
            )}
            {ready && (
              <button
                type="button"
                className="primary-button"
                disabled={accepting}
                onClick={() => void accept()}
              >
                {accepting ? "Opening…" : "Use this model"}
                <ArrowUpRight size={16} />
              </button>
            )}
          </div>
        </form>
        {busy && (
          <p className="ai-footnote">You can close this while it builds.</p>
        )}
      </div>
      {ready && (
        <div className="ai-preview">
          <Scene
            theme={theme}
            parts={job!.parts}
            selected={[]}
            ghosts={[]}
            valid
            viewers={[]}
            guest=""
            generation={1}
            grid={false}
            quality={false}
            cameraMode={`iso:${job!.id}`}
            frameParts
            presentation
            selectMode={false}
            canMove={false}
            dragging={false}
            onGrab={() => false}
            onDrag={() => {}}
            onDrop={() => {}}
            onCancelDrag={() => {}}
            onCursor={() => {}}
            onHover={() => {}}
            onClick={() => {}}
          />
          <div className="ai-preview-caption">
            <Blocks size={15} />
            <span>{job!.blueprint?.title}</span>
          </div>
        </div>
      )}
    </dialog>
  );
}
