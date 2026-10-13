import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, LoaderCircle, X } from "lucide-react";
import type { AIGeneration } from "../shared/types";
import { api } from "./store";
import type { Theme } from "./theme";

export default function AIBuildDialog({
  onClose,
}: {
  theme: Theme;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const reservation = useRef<{ id: string; prompt: string } | null>(null);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  async function build() {
    if (busy || prompt.trim().length < 3) return;
    setBusy(true);
    setError("");
    // Reuse this operation on a lost response; never create a second workshop.
    if (!reservation.current || reservation.current.prompt !== prompt.trim())
      reservation.current = { id: crypto.randomUUID(), prompt: prompt.trim() };
    const input = reservation.current;
    try {
      const row = await api<AIGeneration>("/ai/generations", {
        method: "POST",
        body: JSON.stringify({ ...input, newWorld: true }),
      }).catch(async (e) => {
        try {
          return await api<AIGeneration>(`/ai/generations/${input.id}`);
        } catch {
          throw e;
        }
      });
      if (!row.target_slug)
        throw new Error(
          "The AI workshop could not be opened. Please try again.",
        );
      location.assign(`/w/${row.target_slug}?ai=1&frame=1`);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  return (
    <dialog
      ref={dialog}
      className="ai-dialog"
      aria-labelledby="ai-title"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <button
        className="modal-close"
        aria-label="Close AI builder"
        disabled={busy}
        onClick={onClose}
      >
        <X size={18} />
      </button>
      <div className="ai-copy">
        <h2 id="ai-title">What shall we build?</h2>
        <p className="ai-intro">
          Start a model, then keep shaping it together.
        </p>
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
            placeholder="A cosy cabin with a red roof and a little pine tree…"
            value={prompt}
            disabled={busy}
            onChange={(e) => setPrompt(e.target.value)}
          />
          <div className="ai-examples">
            {[
              "A little forest lookout with a red roof",
              "A yellow exploration rover with chunky wheels",
              "A seaside lighthouse with a keeper's house",
            ].map((example) => (
              <button
                key={example}
                type="button"
                disabled={busy}
                onClick={() => setPrompt(example)}
              >
                {example}
                <ArrowUpRight size={12} />
              </button>
            ))}
          </div>
          {error && (
            <p className="ai-error" role="alert">
              {error}
            </p>
          )}
          <div className="ai-actions">
            <button
              className="primary-button"
              disabled={busy || prompt.trim().length < 3}
            >
              {busy ? (
                <>
                  <LoaderCircle size={16} className="spin" />
                  Opening your canvas…
                </>
              ) : (
                <>
                  Build
                  <ArrowUpRight size={16} />
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </dialog>
  );
}
