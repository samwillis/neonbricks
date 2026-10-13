import { useEffect, useMemo, useRef, useState } from "react";
import {
  Blocks,
  MousePointer2,
  RotateCw,
  Undo2,
  Redo2,
  Trash2,
  Copy,
  Move,
  Eye,
  EyeOff,
  Grid3X3,
  ChevronDown,
  ChevronRight,
  Search,
  Plus,
  Link2,
  Check,
  Box,
  ArrowUpRight,
  HelpCircle,
  X,
  ArrowLeft,
  SlidersHorizontal,
  Wifi,
  LoaderCircle,
  Focus,
  PanelRight,
  UserRound,
  Sun,
  Moon,
  Monitor,
  Sparkles,
} from "lucide-react";
import * as THREE from "three";
import Scene, { type FrameMetrics } from "./Scene";
import AIBuildDialog from "./AIBuildDialog";
import AIBuildPanel from "./AIBuildPanel";
import {
  CATALOGUE,
  BY_KEY,
  COLORS,
  type Definition,
} from "../shared/catalogue";
import { bounds } from "../shared/geometry";
import type { AIGeneration, Part, Preview, Position } from "../shared/types";
import {
  useWorkshop,
  start,
  stop,
  submit,
  displayParts,
  setIntent,
  setCursor,
  sendPresence,
  selectedConnections,
  notice,
  newRoom,
  resetRoom,
  lifecycleRoom,
  rename,
  getState,
  getViewerId,
  serverNow,
} from "./store";
import { thumbnail } from "./shapes";
import {
  captureMove,
  fitsScene,
  movedParts,
  moveRequest,
  snapMovement,
  type MoveSnapshot,
} from "./movement";
import { snapToSurface, type DragSurface } from "./snapping";
import { useTheme, type Theme } from "./theme";
import { CURSOR_TTL } from "./cursors";
type Tool = "select" | "build" | "move" | "duplicate";
function Thumb({ def, theme }: { def: Definition; theme: Theme }) {
  const [src, setSrc] = useState("");
  useEffect(() => {
    try {
      setSrc(thumbnail(def, theme));
    } catch {}
  }, [def, theme]);
  return src ? <img src={src} alt="" draggable={false} /> : <Box size={32} />;
}
function Logo() {
  return (
    <svg className="brand" viewBox="0 0 169 36" aria-hidden="true">
      <use className="brand-symbol" href="/brand/neonbricks.svg#brick" />
      <use href="/brand/neonbricks.svg#wordmark" />
    </svg>
  );
}
function ToolButton({
  icon: Icon,
  label,
  active,
  disabled,
  onClick,
}: {
  icon: typeof Blocks;
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className={`tool-button ${active ? "active" : ""}`}
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
    >
      <Icon size={19} strokeWidth={1.7} />
    </button>
  );
}
export default function App() {
  const { theme, preference, setPreference } = useTheme();
  const [displayMenu, setDisplayMenu] = useState(false);
  const [aiDialog, setAiDialog] = useState(false);
  const [aiPanel, setAiPanel] = useState(
    new URLSearchParams(location.search).has("ai"),
  );
  const [aiDraft, setAiDraft] = useState<AIGeneration | null>(null);
  const displayControl = useRef<HTMLDivElement>(null);
  const displayButton = useRef<HTMLButtonElement>(null);
  const inspectorButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!displayMenu) return;
    const closeOutside = (event: PointerEvent) => {
      if (!displayControl.current?.contains(event.target as Node))
        setDisplayMenu(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setDisplayMenu(false);
        displayButton.current?.focus();
      }
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [displayMenu]);
  const state = useWorkshop(),
    [tool, setTool] = useState<Tool>("select"),
    [key, setKey] = useState("brick-2x4"),
    [color, setColor] = useState(COLORS[0].hex),
    [rotation, setRotation] = useState(0),
    [pose, setPose] = useState<Position | null>(null),
    [drag, setDrag] = useState<MoveSnapshot | null>(null),
    [keepPlacing, setKeepPlacing] = useState(false),
    [selected, setSelected] = useState<string[]>([]),
    [category, setCategory] = useState("All"),
    [search, setSearch] = useState(""),
    [grid, setGrid] = useState(true),
    [quality, setQuality] = useState(false),
    [presentation, setPresentation] = useState(false),
    [camera, setCamera] = useState("iso"),
    [help, setHelp] = useState(false),
    [roomMenu, setRoomMenu] = useState(false),
    [inspector, setInspector] = useState(false),
    [nameMenu, setNameMenu] = useState(false),
    [name, setName] = useState(""),
    [copied, setCopied] = useState(false),
    [tick, setTick] = useState(0),
    [welcome, setWelcome] = useState(true);
  const generation = useRef(0),
    duplicateIds = useRef<string[]>([]),
    held = useRef(false);
  const pickup = useRef<MoveSnapshot | null>(null);
  const dragRef = useRef<MoveSnapshot | null>(null);
  const placing = useRef(false);
  const [metrics, setMetrics] = useState<FrameMetrics | null>(null);
  useEffect(() => {
    const slug = location.pathname.match(/^\/w\/([\w-]+)/)?.[1] || "workshop";
    void start(slug);
    return stop;
  }, []);
  useEffect(() => {
    const timer = setInterval(() => {
      setTick((v) => v + 1);
      if (document.visibilityState === "visible") void sendPresence(true);
    }, 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (state.world && generation.current !== state.world.generation) {
      generation.current = state.world.generation;
      setSelected([]);
      setPose(null);
      setTool("select");
      pickup.current = null;
      dragRef.current = null;
      setDrag(null);
    }
  }, [state.world?.generation]);
  const parts = useMemo(() => displayParts(), [state.parts, state.pending]),
    selection = state.parts.filter((p) => selected.includes(p.id)),
    selectionIds = selection.map((p) => p.id);
  const base = selection.length
    ? {
        x: Math.min(...selection.map((p) => p.position.x)),
        y: Math.min(...selection.map((p) => p.position.y)),
        z: Math.min(...selection.map((p) => p.position.z)),
      }
    : null;
  const ghosts = useMemo<Preview[]>(() => {
    if (drag) return movedParts(drag);
    if (!pose || tool === "select") return [];
    if (tool === "build") return [{ key, color, position: pose, rotation }];
    if (!base) return [];
    return selection.map((p) => ({
      key: p.key,
      color: p.color,
      rotation: p.rotation,
      position: {
        x: p.position.x + pose.x - base.x,
        y: p.position.y + pose.y - base.y,
        z: p.position.z + pose.z - base.z,
      },
    }));
  }, [drag, pose, tool, key, color, rotation, JSON.stringify(selection)]);
  const valid = useMemo(
    () =>
      fitsScene(
        ghosts.map((g, i) => ({ ...g, id: `ghost-${i}`, revision: 0 })),
        state.parts,
        drag ? drag.parts.map((p) => p.id) : tool === "move" ? selected : [],
      ),
    [ghosts, state.parts, selected, tool, drag],
  );
  useEffect(() => {
    setIntent(ghosts[0] || null, selectionIds);
  }, [JSON.stringify(ghosts), selectionIds.join(",")]);
  const viewers = state.viewers.filter(
    (v) => Date.parse(v.expires_at) > serverNow(),
  );
  const remote = viewers.map((v) => ({
    ...v,
    cursor:
      v.cursor_at && serverNow() - Date.parse(v.cursor_at) < CURSOR_TTL
        ? v.cursor
        : null,
    preview:
      v.preview_at && serverNow() - Date.parse(v.preview_at) < 3000
        ? v.preview
        : null,
  }));
  const canEdit =
    state.status === "live" && state.world?.status === "open" && !aiDraft;
  const filtered = CATALOGUE.filter(
    (d) =>
      (category === "All" || d.category === category) &&
      (d.name.toLowerCase().includes(search.toLowerCase()) ||
        d.key.includes(search.toLowerCase())),
  );
  function beginBuild(d: Definition) {
    cancelDrag();
    setKey(d.key);
    setTool("build");
    setSelected([]);
    setPose(null);
    setRotation(0);
    setWelcome(false);
    notice(null);
  }
  function cancel() {
    cancelDrag();
    setTool("select");
    setPose(null);
    setIntent(null, selected);
  }
  function cancelDrag() {
    pickup.current = null;
    dragRef.current = null;
    setDrag(null);
  }
  function grab(part?: Part, shift = false) {
    if (tool !== "select" || presentation) return false;
    const ids = part
      ? shift
        ? selected.includes(part.id)
          ? selected.filter((id) => id !== part.id)
          : [...selected, part.id]
        : selected.includes(part.id)
          ? selected
          : [part.id]
      : selected;
    setSelected(ids);
    setWelcome(false);
    const current = getState();
    if (shift || !canEdit || current.pending.length) return false;
    const picked = current.parts.filter((p) => ids.includes(p.id));
    if (!picked.length || !current.world) return false;
    pickup.current = captureMove(
      picked,
      current.connections,
      current.world.generation,
    );
    notice(null);
    return true;
  }
  function dragTo(delta: Position, hover?: DragSurface) {
    if (!pickup.current) return;
    if (hover) {
      const preferred = snapMovement(hover.delta, undefined, hover.fine);
      preferred.y = Math.round(hover.delta.y / 2) * 2;
      delta = snapToSurface(
        pickup.current.parts,
        hover.surface,
        preferred,
        getState().parts,
        { excluded: pickup.current.parts.map((p) => p.id), fine: hover.fine },
      ).delta;
    }
    const previous = dragRef.current?.delta;
    if (
      previous &&
      previous.x === delta.x &&
      previous.y === delta.y &&
      previous.z === delta.z
    )
      return;
    const next = { ...pickup.current, delta };
    dragRef.current = next;
    setDrag(next);
  }
  function drop() {
    const move = dragRef.current;
    cancelDrag();
    if (!move || !Object.values(move.delta).some(Boolean)) return;
    const current = getState();
    if (
      current.world?.generation !== move.generation ||
      current.status !== "live" ||
      current.world.status !== "open"
    ) {
      notice("The workshop changed during your move. Please try again.");
      return;
    }
    if (
      !fitsScene(
        movedParts(move),
        current.parts,
        move.parts.map((p) => p.id),
      )
    ) {
      notice(
        "That space is occupied or outside the workbench. Your pieces stayed in place.",
      );
      return;
    }
    void submit(moveRequest(move));
  }
  async function change(
    changes: NonNullable<Parameters<typeof submit>[0]["changes"]>,
  ) {
    return submit({
      action: "edit",
      changes,
      connections: selectedConnections(changes.map((p) => p.id)),
    });
  }
  async function rotate() {
    if (tool === "build") {
      setRotation((r) => (r + 1) % 4);
      return;
    }
    if (!selection.length || !canEdit || pickup.current) return;
    const minx = Math.min(...selection.map((p) => bounds(p).minx)),
      minz = Math.min(...selection.map((p) => bounds(p).minz)),
      maxz = Math.max(...selection.map((p) => bounds(p).maxz));
    await change(
      selection.map((p) => ({
        id: p.id,
        expected: p.revision,
        rotation: (p.rotation + 1) % 4,
        position: {
          x: minx + maxz - bounds(p).maxz,
          y: p.position.y,
          z: minz + p.position.x - minx,
        },
      })),
    );
  }
  async function remove() {
    if (!selection.length || !canEdit || pickup.current) return;
    if (
      await change(
        selection.map((p) => ({
          id: p.id,
          expected: p.revision,
          deleted: true,
        })),
      )
    )
      setSelected([]);
  }
  function beginMove(duplicate = false) {
    if (!selection.length || !canEdit) return;
    cancelDrag();
    duplicateIds.current = selection.map(() => crypto.randomUUID());
    setTool(duplicate ? "duplicate" : "move");
    setPose(null);
    setWelcome(false);
  }
  async function undo(redo = false) {
    const target = redo ? state.history.redo : state.history.undo;
    if (!target || !canEdit || state.pending.length) return;
    cancel();
    await submit({ action: redo ? "redo" : "undo", target });
  }
  const actions = useRef({ rotate, remove, beginMove, undo, cancel });
  actions.current = { rotate, remove, beginMove, undo, cancel };
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (
        (e.target as HTMLElement)?.closest(
          'input:not([type="checkbox"]),textarea,[contenteditable="true"]',
        )
      )
        return;
      const a = actions.current;
      if (e.key === "Escape") {
        const moving = !!pickup.current;
        a.cancel();
        if (!moving) setSelected([]);
        setHelp(false);
        setInspector(false);
      } else if (e.key.toLowerCase() === "r" && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        void a.rotate();
      } else if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        void a.remove();
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        void a.undo(e.shiftKey);
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "d") {
        e.preventDefault();
        a.beginMove(true);
      } else if (e.key.toLowerCase() === "m") a.beginMove();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);
  function hover(
    point: THREE.Vector3,
    normal: THREE.Vector3 | undefined,
    part?: Part,
  ) {
    if (tool === "select" || !canEdit || pickup.current) return;
    const step = held.current ? 1 : 6;
    const next = {
      x: Math.floor((point.x * 6 + 0.001) / step) * step,
      y: Math.max(0, Math.round((point.y * 6 + 0.01) / 2) * 2),
      z: Math.floor((point.z * 6 + 0.001) / step) * step,
    };
    const source: Part = {
      id: "preview",
      key,
      color,
      position: { x: 0, y: 0, z: 0 },
      rotation,
      revision: 0,
    };
    const moving = tool === "build" ? [source] : selection;
    if (!moving.length || (tool !== "build" && !base)) return;
    const origin = tool === "build" ? { x: 0, y: 0, z: 0 } : base!;
    const snapped = snapToSurface(
      moving,
      {
        part,
        point: { x: point.x * 6, y: point.y * 6, z: point.z * 6 },
        normal: normal || { x: 0, y: 1, z: 0 },
      },
      { x: next.x - origin.x, y: next.y - origin.y, z: next.z - origin.z },
      state.parts,
      {
        excluded: tool === "move" ? selected : [],
        fine: held.current,
        rotate: tool === "build",
      },
    );
    Object.assign(next, {
      x: origin.x + snapped.delta.x,
      y: origin.y + snapped.delta.y,
      z: origin.z + snapped.delta.z,
    });
    if (tool === "build" && snapped.parts[0].rotation !== rotation)
      setRotation(snapped.parts[0].rotation);
    setPose((p) =>
      p && p.x === next.x && p.y === next.y && p.z === next.z ? p : next,
    );
  }
  async function click(part?: Part, shift = false) {
    if (presentation) return;
    if (tool === "select") {
      setSelected((ids) =>
        part
          ? shift
            ? ids.includes(part.id)
              ? ids.filter((id) => id !== part.id)
              : [...ids, part.id]
            : [part.id]
          : [],
      );
      return;
    }
    if (!ghosts.length || !canEdit || placing.current) return;
    if (!valid) {
      notice("That space is occupied or outside the workbench.");
      return;
    }
    let accepted = false;
    if (tool === "build") {
      const id = crypto.randomUUID();
      placing.current = true;
      // Return to selection immediately while the optimistic placement saves.
      if (!keepPlacing) {
        cancel();
        setSelected([id]);
      }
      try {
        accepted = await submit({
          action: "edit",
          changes: [{ id, ...ghosts[0] }],
        });
      } finally {
        placing.current = false;
      }
    } else if (tool === "move") {
      accepted = await change(
        selection.map((p, i) => ({
          id: p.id,
          expected: p.revision,
          position: ghosts[i].position,
          rotation: ghosts[i].rotation,
        })),
      );
    } else {
      accepted = await submit({
        action: "edit",
        changes: ghosts.map((g, i) => ({ id: duplicateIds.current[i], ...g })),
      });
    }
    if (accepted) {
      notice(null);
      if (tool !== "build") {
        cancel();
        setSelected(tool === "duplicate" ? duplicateIds.current : selected);
      } else setWelcome(false);
    }
  }
  async function chooseColor(hex: string) {
    setColor(hex);
    if (selection.length && tool === "select" && canEdit && !pickup.current)
      await change(
        selection.map((p) => ({ id: p.id, expected: p.revision, color: hex })),
      );
  }
  async function invite() {
    try {
      await navigator.clipboard.writeText(location.href);
      setCopied(true);
      setTimeout(() => setCopied(false), 2200);
    } catch {
      notice(`Invite link: ${location.href}`);
    }
  }
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
        held.current = e.altKey;
      },
      up = () => {
        held.current = false;
      };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, []);
  return (
    <div className={`app ${presentation ? "presenting" : ""}`}>
      <header className="header">
        <a href="/" className="brand-link" aria-label="Neon Bricks home">
          <Logo />
        </a>
        <div className="header-rule" />
        <div className="room-control">
          <button className="room-title" onClick={() => setRoomMenu((v) => !v)}>
            <span>{state.world?.title || "The little workshop"}</span>
            <ChevronDown size={14} />
          </button>
          {roomMenu && (
            <div className="popover room-popover">
              <div className="popover-heading">WORKSHOPS</div>
              <button
                disabled={!state.guest}
                onClick={() => {
                  cancel();
                  setRoomMenu(false);
                  setAiDialog(true);
                }}
              >
                <Sparkles size={16} />
                Build with AI
                <ChevronRight size={14} />
              </button>
              <button
                onClick={() =>
                  void newRoom(false).catch((e) => notice(e.message))
                }
              >
                <Blocks size={16} />
                New rover workshop
                <ChevronRight size={14} />
              </button>
              <button
                onClick={() =>
                  void newRoom(true).catch((e) => notice(e.message))
                }
              >
                <Plus size={16} />
                Start with a blank canvas
                <ChevronRight size={14} />
              </button>
              {state.canReset && (
                <>
                  <div className="menu-divider" />
                  <button
                    onClick={() => {
                      setRoomMenu(false);
                      void lifecycleRoom(
                        state.world?.status === "open" ? "closed" : "open",
                      ).catch((e) => notice(e.message));
                    }}
                  >
                    <EyeOff size={16} />
                    {state.world?.status === "open"
                      ? "Close my workshop"
                      : "Reopen my workshop"}
                  </button>
                  <button
                    onClick={() => {
                      setRoomMenu(false);
                      void resetRoom(false).catch((e) => notice(e.message));
                    }}
                  >
                    <RotateCw size={16} />
                    Restore starter model
                  </button>
                  <button
                    onClick={() => {
                      setRoomMenu(false);
                      void resetRoom(true).catch((e) => notice(e.message));
                    }}
                  >
                    <Trash2 size={16} />
                    Clear my workshop
                  </button>
                </>
              )}
            </div>
          )}
        </div>
        <div className="header-spacer" />
        <button
          className={`ai-chat-toggle ${aiPanel ? "active" : ""}`}
          disabled={!state.guest}
          aria-label="AI chat"
          aria-expanded={aiPanel}
          title="Ask AI to change this model"
          onClick={() => {
            cancel();
            setAiPanel((v) => !v);
          }}
        >
          <Sparkles size={16} />
          <span>AI</span>
        </button>
        <div
          className="collaborators"
          title={viewers.map((v) => v.name).join(", ")}
        >
          <div className="avatars">
            {viewers.slice(0, 4).map((v) => (
              <span key={v.id} style={{ background: v.color }}>
                {v.name.charAt(0).toUpperCase()}
              </span>
            ))}
          </div>
          <span>{Math.max(1, viewers.length)} here</span>
        </div>
        <button
          className="invite-button"
          aria-label={copied ? "Link copied" : "Invite"}
          onClick={() => void invite()}
        >
          {copied ? <Check size={16} /> : <Link2 size={16} />}
          <span>{copied ? "Link copied" : "Invite"}</span>
        </button>
        <div className="display-control" ref={displayControl}>
          <button
            ref={displayButton}
            className="icon-button"
            aria-label="Display"
            title="Display"
            aria-expanded={displayMenu}
            aria-controls="display-options"
            onClick={() => setDisplayMenu((v) => !v)}
          >
            <SlidersHorizontal size={18} />
          </button>
          {displayMenu && (
            <div
              id="display-options"
              className="popover display-popover"
              role="group"
              aria-label="Display options"
            >
              <div className="popover-heading">APPEARANCE</div>
              {(
                [
                  { value: "light", label: "Light", icon: Sun },
                  { value: "dark", label: "Dark", icon: Moon },
                  { value: "system", label: "System", icon: Monitor },
                ] as const
              ).map(({ value, label, icon: Icon }) => (
                <button
                  key={value}
                  aria-pressed={preference === value}
                  onClick={() => setPreference(value)}
                >
                  <Icon size={16} />
                  {label}
                  {preference === value && <Check size={14} />}
                </button>
              ))}
              <div className="menu-divider" />
              <button aria-pressed={grid} onClick={() => setGrid((v) => !v)}>
                <Grid3X3 size={16} />
                Construction grid
                {grid && <Check size={14} />}
              </button>
              <button
                aria-pressed={!quality}
                title="Soft shadows and sharper detail. Turn off to improve performance."
                onClick={() => setQuality((v) => !v)}
              >
                <Sun size={16} />
                Enhanced lighting
                {!quality && <Check size={14} />}
              </button>
            </div>
          )}
        </div>
        <button
          className="icon-button help-button"
          title="How to build"
          aria-label="How to build"
          onClick={() => setHelp(true)}
        >
          <HelpCircle size={19} />
        </button>
        <div className="self-control">
          <button
            className="self-avatar"
            style={{ background: state.color }}
            title="Your builder name"
            onClick={() => {
              setName(state.name);
              setNameMenu((v) => !v);
            }}
          >
            {state.name.charAt(0) || "B"}
          </button>
          {nameMenu && (
            <form
              className="popover name-popover"
              onSubmit={(e) => {
                e.preventDefault();
                void rename(name)
                  .then(() => setNameMenu(false))
                  .catch((e) => notice(e.message));
              }}
            >
              <label>
                Your builder name
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={24}
                  required
                />
              </label>
              <button className="primary-button">
                Save name
                <Check size={14} />
              </button>
            </form>
          )}
        </div>
      </header>
      <div className={`workspace ${aiPanel ? "with-ai-chat" : ""}`}>
        {!aiPanel && (
          <aside className="drawer">
            <div className="drawer-heading">
              <div>
                <h1>
                  Parts<span>.</span>
                </h1>
              </div>
              <span className="count-badge">36</span>
            </div>
            <div className="search">
              <Search size={16} />
              <input
                aria-label="Search parts"
                placeholder="Search parts…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              {search && (
                <button aria-label="Clear search" onClick={() => setSearch("")}>
                  <X size={13} />
                </button>
              )}
            </div>
            <div className="categories">
              {["All", "Bricks", "Plates", "Mechanics"].map((name) => (
                <button
                  key={name}
                  className={category === name ? "chosen" : ""}
                  onClick={() => setCategory(name)}
                  title={name}
                  aria-pressed={category === name}
                >
                  <span>{name}</span>
                </button>
              ))}
            </div>
            <div className="parts-list">
              <div className="parts-grid">
                {filtered.map((d) => (
                  <button
                    key={d.key}
                    className={`part-card ${tool === "build" && key === d.key ? "picked" : ""}`}
                    data-testid={`part-${d.key}`}
                    aria-label={`Build with ${d.name}`}
                    onClick={() => beginBuild(d)}
                  >
                    <span className="part-thumb">
                      <Thumb def={d} theme={theme} />
                      {tool === "build" && key === d.key && (
                        <span className="pick-mark">
                          <Check size={10} />
                        </span>
                      )}
                    </span>
                    <span className="part-name">{d.name}</span>
                    <span className="part-measure">
                      {d.w} × {d.d}
                      {d.category === "Mechanics" && (
                        <span className="mechanic-dot" />
                      )}
                    </span>
                  </button>
                ))}
              </div>
              {filtered.length === 0 && (
                <div className="no-parts">
                  No pieces found.
                  <button
                    onClick={() => {
                      setSearch("");
                      setCategory("All");
                    }}
                  >
                    Show all pieces
                  </button>
                </div>
              )}
            </div>
            <div className="color-drawer">
              <div className="section-label">
                <span>Colour</span>
                <span>{COLORS.find((c) => c.hex === color)?.name}</span>
              </div>
              <div className="swatches">
                {COLORS.map((c) => (
                  <button
                    key={c.hex}
                    className={`swatch ${color === c.hex ? "picked" : ""}`}
                    style={{ background: c.hex }}
                    title={c.name}
                    aria-label={`Colour ${c.name}`}
                    onClick={() => void chooseColor(c.hex)}
                  >
                    {color === c.hex && (
                      <Check
                        size={13}
                        color={
                          ["#eee8dc", "#edbc46", "#9fc5b4"].includes(c.hex)
                            ? "#354a40"
                            : "white"
                        }
                      />
                    )}
                  </button>
                ))}
              </div>
            </div>
          </aside>
        )}
        <main className="stage">
          <Scene
            theme={theme}
            parts={
              aiDraft?.status === "ready" && aiDraft.parts.length
                ? aiDraft.parts
                : aiDraft?.preview?.parts || parts
            }
            selected={aiDraft ? [] : selected}
            ghosts={aiDraft ? [] : ghosts}
            valid={valid}
            viewers={aiDraft ? [] : remote}
            guest={getViewerId()}
            generation={state.world?.generation || 1}
            grid={grid}
            quality={quality}
            cameraMode={
              aiDraft?.status === "ready" && camera.startsWith("iso")
                ? `${camera}:${aiDraft.id}:ready`
                : camera
            }
            frameParts={
              aiDraft
                ? aiDraft.status === "ready"
                : new URLSearchParams(location.search).has("frame")
            }
            presentation={presentation}
            selectMode={tool === "select" && !aiDraft}
            canMove={canEdit && !state.pending.length}
            dragging={!!drag}
            onGrab={grab}
            onDrag={dragTo}
            onDrop={drop}
            onCancelDrag={cancelDrag}
            onMetrics={inspector ? setMetrics : undefined}
            onCursor={setCursor}
            onHover={hover}
            onClick={(p, shift) => void click(p, shift)}
          />
          {welcome &&
            !presentation &&
            !aiPanel &&
            tool === "select" &&
            !selection.length && (
              <div className="welcome-note">
                <h2>Build together.</h2>
                <p>Pick a part, then click to place it.</p>
                <button
                  className="dismiss-welcome"
                  aria-label="Hide introduction"
                  onClick={() => setWelcome(false)}
                >
                  <X size={14} />
                </button>
              </div>
            )}
          <div className="view-controls">
            <div className="view-buttons">
              {["iso", "top", "front"].map((view) => (
                <button
                  key={view}
                  className={camera.startsWith(view) ? "active" : ""}
                  onClick={() => setCamera(`${view}:${Date.now()}`)}
                >
                  {view === "iso" ? "3D" : view === "top" ? "Top" : "Front"}
                </button>
              ))}
              <button
                title="Reset camera"
                aria-label="Reset camera"
                onClick={() => setCamera(`iso:${Date.now()}`)}
              >
                <Focus size={16} />
              </button>
            </div>
          </div>
          {aiDraft && (
            <div className="ai-canvas-status">
              <Sparkles size={14} />
              <span>
                {aiDraft.status === "ready"
                  ? "Draft preview · ready to apply"
                  : `${aiDraft.activity || "Building your draft"} · preview`}
              </span>
            </div>
          )}
          {!presentation &&
            !aiDraft &&
            selection.length > 0 &&
            tool === "select" && (
              <div className="selection-card">
                <span>
                  {selection.length === 1
                    ? BY_KEY[selection[0].key]?.name
                    : `${selection.length} pieces selected`}
                </span>
                <button
                  aria-label="Clear selection"
                  onClick={() => setSelected([])}
                >
                  <X size={14} />
                </button>
              </div>
            )}
          {!presentation && (
            <div className="build-hint">
              {tool === "build" ? (
                <>
                  <span className={`hint-dot ${valid ? "" : "invalid"}`} />
                  {BY_KEY[key].name}
                  <span className="hint-divider" />
                  <label className="keep-placing">
                    <input
                      type="checkbox"
                      checked={keepPlacing}
                      onChange={(e) => setKeepPlacing(e.target.checked)}
                    />
                    Keep placing
                  </label>
                  <kbd>R</kbd> rotate<kbd>esc</kbd> cancel
                </>
              ) : tool === "move" || tool === "duplicate" ? (
                <>
                  <Move size={14} />
                  Place {selection.length}{" "}
                  {selection.length === 1 ? "piece" : "pieces"}
                  <kbd>esc</kbd> cancel
                </>
              ) : (
                <>
                  <MousePointer2 size={14} />
                  {drag
                    ? "Release to place · Esc to cancel"
                    : selection.length
                      ? "Drag a piece or an arrow to move"
                      : "Click a piece to select"}
                  <span className="hint-divider" />
                  {selection.length
                    ? "Shift-click to select more"
                    : "Drag the background to orbit"}
                </>
              )}
            </div>
          )}
          <div className="tool-dock">
            {presentation ? (
              <>
                <ToolButton
                  icon={ArrowLeft}
                  label="Back to building"
                  onClick={() => setPresentation(false)}
                />
                <span className="presentation-label">Neon Bricks</span>
              </>
            ) : (
              <>
                <ToolButton
                  icon={MousePointer2}
                  label="Select pieces"
                  active={tool === "select"}
                  onClick={cancel}
                />
                <ToolButton
                  icon={Blocks}
                  label="Place a piece"
                  active={tool === "build"}
                  onClick={() => beginBuild(BY_KEY[key])}
                />
                <span className="dock-divider" />
                <ToolButton
                  icon={RotateCw}
                  label="Rotate (R)"
                  disabled={tool !== "build" && !selection.length}
                  onClick={() => void rotate()}
                />
                <ToolButton
                  icon={Move}
                  label="Move selection (M)"
                  disabled={!selection.length || !canEdit}
                  active={tool === "move"}
                  onClick={() => beginMove()}
                />
                <ToolButton
                  icon={Copy}
                  label="Duplicate (⌘D)"
                  disabled={!selection.length || !canEdit}
                  active={tool === "duplicate"}
                  onClick={() => beginMove(true)}
                />
                <span className="dock-divider" />
                <ToolButton
                  icon={Undo2}
                  label="Undo (⌘Z)"
                  disabled={!state.history.undo || !canEdit}
                  onClick={() => void undo()}
                />
                <ToolButton
                  icon={Redo2}
                  label="Redo (⇧⌘Z)"
                  disabled={!state.history.redo || !canEdit}
                  onClick={() => void undo(true)}
                />
                <ToolButton
                  icon={Trash2}
                  label="Delete selection"
                  disabled={!selection.length || !canEdit}
                  onClick={() => void remove()}
                />
                <span className="dock-divider" />
                <ToolButton
                  icon={Eye}
                  label="Presentation mode"
                  onClick={() => {
                    cancel();
                    setSelected([]);
                    setPresentation(true);
                  }}
                />
              </>
            )}
          </div>
          <div className="inspector-control">
            <button
              ref={inspectorButton}
              className="inspector-toggle"
              aria-label="Demo inspector"
              title="Demo inspector"
              aria-expanded={inspector}
              aria-controls="demo-inspector"
              onClick={() => setInspector((v) => !v)}
            >
              <PanelRight size={16} />
            </button>
            {inspector && (
              <section
                className="inspector"
                id="demo-inspector"
                aria-label="Demo inspector"
              >
                <div className="inspector-heading">
                  <span className="eyebrow">DEMO INSPECTOR</span>
                  <button
                    className="inspector-close"
                    aria-label="Close inspector"
                    onClick={() => {
                      setInspector(false);
                      inspectorButton.current?.focus();
                    }}
                  >
                    <X size={15} />
                  </button>
                </div>
                <dl>
                  <dt>State</dt>
                  <dd>Postgres</dd>
                  <dt>Commands</dt>
                  <dd>Neon Functions</dd>
                  <dt>Updates</dt>
                  <dd>Neon Realtime</dd>
                  <dt>Generation</dt>
                  <dd>{state.world?.generation}</dd>
                  <dt>Connections</dt>
                  <dd>{state.connections.length}</dd>
                  <dt>Last transaction</dt>
                  <dd className="txid">{state.lastTx || "—"}</dd>
                  <dt>Pending</dt>
                  <dd>{state.pending.length}</dd>
                  {metrics && (
                    <>
                      <dt>Frame p95</dt>
                      <dd data-testid="frame-p95">
                        {metrics.p95.toFixed(1)} ms
                      </dd>
                      <dt>Frame rate</dt>
                      <dd>{metrics.fps.toFixed(0)} fps</dd>
                      <dt>Draw calls</dt>
                      <dd>{metrics.calls}</dd>
                      <dt>Triangles</dt>
                      <dd>{metrics.triangles.toLocaleString()}</dd>
                      <dt>Frame samples</dt>
                      <dd>{metrics.samples}</dd>
                    </>
                  )}
                </dl>
              </section>
            )}
          </div>
          {state.error && (
            <div className="toast" role="alert">
              <span>{state.error}</span>
              <button aria-label="Dismiss message" onClick={() => notice(null)}>
                <X size={15} />
              </button>
            </div>
          )}
          {state.status === "connecting" && state.parts.length === 0 && (
            <div className="loading-card">
              <LoaderCircle className="spin" size={18} />
              <span>Opening the workshop…</span>
            </div>
          )}
        </main>
        {aiPanel && state.world && (
          <AIBuildPanel
            key={state.world.id}
            world={state.world.id}
            onClose={() => {
              setAiPanel(false);
              setAiDraft(null);
            }}
            onPreview={setAiDraft}
          />
        )}
      </div>
      <footer className="footer">
        <span className="connection-status">
          <i
            className={
              state.status === "live"
                ? "connected"
                : state.status === "error"
                  ? "failed"
                  : ""
            }
          />
          {state.status === "live"
            ? state.world?.status !== "open"
              ? "Workshop closed"
              : state.pending.length
                ? "Saving…"
                : "Live & saved"
            : state.status === "error"
              ? "Connection unavailable"
              : "Reconnecting…"}
        </span>
        <span className="footer-count">
          {parts.length} pieces<span>·</span>
          {state.connections.length} connections
        </span>
        <div className="footer-spacer" />
        <span className="footer-message">Build together in realtime</span>
        <a
          href="https://neon.com"
          target="_blank"
          rel="noreferrer"
          className="powered"
          aria-label="Neon Realtime"
        >
          Neon Realtime
          <ArrowUpRight size={11} />
        </a>
      </footer>
      {aiDialog && (
        <AIBuildDialog theme={theme} onClose={() => setAiDialog(false)} />
      )}
      {help && (
        <div className="modal-scrim" onClick={() => setHelp(false)}>
          <section
            className="help-modal"
            role="dialog"
            aria-modal="true"
            aria-label="How to build"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              className="modal-close"
              aria-label="Close help"
              onClick={() => setHelp(false)}
            >
              <X size={18} />
            </button>
            <span className="eyebrow">NEON BRICKS</span>
            <h2>Build together.</h2>
            <p>
              Choose a piece from the drawer and click the workbench to place
              it. Green means it fits. Your friends see it as soon as it’s
              saved. Enable Keep placing to add several of the same piece.
            </p>
            <div className="help-rows">
              <div>
                <kbd>drag</kbd>
                <span>
                  Drag a piece onto a brick or compatible connector to snap.
                  Drag the background to orbit. Right-drag to pan, scroll to
                  zoom.
                </span>
              </div>
              <div>
                <kbd>X Y Z</kbd>
                <span>
                  Click a piece to reveal arrows. Drag Y to raise or lower it.
                </span>
              </div>
              <div>
                <kbd>R</kbd>
                <span>Rotate a preview or your selected pieces.</span>
              </div>
              <div>
                <kbd>shift</kbd>
                <span>Click to select more than one piece.</span>
              </div>
              <div>
                <kbd>M</kbd>
                <span>
                  Pick up your selection, then click to place. ⌘D makes a copy.
                </span>
              </div>
              <div>
                <kbd>⌘ Z</kbd>
                <span>Undo your edits. ⇧⌘Z to redo.</span>
              </div>
              <div>
                <kbd>alt</kbd>
                <span>
                  Hold for fine placement, useful for mechanical parts.
                </span>
              </div>
              <div>
                <kbd>esc</kbd>
                <span>Cancel placement and return to selecting.</span>
              </div>
            </div>
            <p className="help-note">
              Mechanical parts fit together as static assemblies. Moving parts
              and motors are coming in a later phase.
            </p>
            <button className="primary-button" onClick={() => setHelp(false)}>
              Start building
              <ArrowUpRight size={16} />
            </button>
          </section>
        </div>
      )}
    </div>
  );
}
