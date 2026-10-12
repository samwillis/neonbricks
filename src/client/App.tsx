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
  Minus,
  Link2,
  Check,
  Box,
  Layers3,
  Cog,
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
} from "lucide-react";
import * as THREE from "three";
import Scene, { type FrameMetrics } from "./Scene";
import {
  CATALOGUE,
  BY_KEY,
  COLORS,
  type Definition,
} from "../shared/catalogue";
import {
  collision,
  validPart,
  bounds,
  connectorList,
  mating,
} from "../shared/geometry";
import type { Part, Preview, Position } from "../shared/types";
import {
  useWorkshop,
  start,
  stop,
  submit,
  displayParts,
  setIntent,
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
type Tool = "select" | "build" | "move" | "duplicate";
function Thumb({ def }: { def: Definition }) {
  const [src, setSrc] = useState("");
  useEffect(() => {
    try {
      setSrc(thumbnail(def));
    } catch {}
  }, [def]);
  return src ? <img src={src} alt="" draggable={false} /> : <Box size={32} />;
}
function Logo() {
  return (
    <span className="brand">
      <span className="brand-mark">
        <i />
        <i />
        <b />
      </span>
      <span>
        neon<span className="brand-divider">/</span>
        <strong>bricks</strong>
      </span>
    </span>
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
  const state = useWorkshop(),
    [tool, setTool] = useState<Tool>("select"),
    [key, setKey] = useState("brick-2x4"),
    [color, setColor] = useState(COLORS[0].hex),
    [rotation, setRotation] = useState(0),
    [pose, setPose] = useState<Position | null>(null),
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
    [autoHeight, setAutoHeight] = useState(true),
    [layer, setLayer] = useState(0),
    [tick, setTick] = useState(0),
    [welcome, setWelcome] = useState(true);
  const generation = useRef(0),
    duplicateIds = useRef<string[]>([]),
    held = useRef(false);
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
  }, [pose, tool, key, color, rotation, JSON.stringify(selection)]);
  const valid = useMemo(
    () =>
      ghosts.every((ghost, i) => {
        const p = { ...ghost, id: `ghost-${i}`, revision: 0 };
        return (
          validPart(p) &&
          !state.parts
            .filter(
              (x) =>
                tool === "build" ||
                tool === "duplicate" ||
                !selected.includes(x.id),
            )
            .some((other) => collision(p, other)) &&
          !ghosts
            .slice(0, i)
            .some((other, j) =>
              collision(p, { ...other, id: `ghost-${j}`, revision: 0 }),
            )
        );
      }),
    [ghosts, state.parts, selected, tool],
  );
  useEffect(() => {
    setIntent(ghosts[0] || null, selectionIds);
  }, [JSON.stringify(ghosts), selectionIds.join(",")]);
  const viewers = state.viewers.filter(
    (v) => Date.parse(v.expires_at) > serverNow(),
  );
  const remote = viewers.map((v) => ({
    ...v,
    preview:
      v.preview_at && serverNow() - Date.parse(v.preview_at) < 3000
        ? v.preview
        : null,
  }));
  const canEdit = state.status === "live" && state.world?.status === "open";
  const filtered = CATALOGUE.filter(
    (d) =>
      (category === "All" || d.category === category) &&
      (d.name.toLowerCase().includes(search.toLowerCase()) ||
        d.key.includes(search.toLowerCase())),
  );
  function beginBuild(d: Definition) {
    setKey(d.key);
    setTool("build");
    setSelected([]);
    setPose(null);
    setRotation(0);
    setWelcome(false);
    notice(null);
  }
  function cancel() {
    setTool("select");
    setPose(null);
    setIntent(null, selected);
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
    if (!selection.length || !canEdit) return;
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
    if (!selection.length || !canEdit) return;
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
      if (
        (e.target as HTMLElement)?.closest(
          "input,textarea,button[contenteditable]",
        )
      )
        return;
      const a = actions.current;
      if (e.key === "Escape") {
        a.cancel();
        setSelected([]);
        setHelp(false);
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
    if (tool === "select" || !canEdit) return;
    const step = held.current ? 1 : 6;
    const next = {
      x: Math.floor((point.x * 6 + 0.001) / step) * step,
      y: autoHeight
        ? Math.max(0, Math.round((point.y * 6 + 0.01) / 2) * 2)
        : layer * 2,
      z: Math.floor((point.z * 6 + 0.001) / step) * step,
    };
    if (part && normal && Math.abs(normal.y) < 0.5) {
      const b = bounds(part);
      if (normal.x > 0.5) next.x = b.maxx;
      if (normal.x < -0.5) next.x = b.minx - (BY_KEY[key]?.w || 1) * 6;
      if (normal.z > 0.5) next.z = b.maxz;
      if (normal.z < -0.5) next.z = b.minz - (BY_KEY[key]?.d || 1) * 6;
    }
    let r = rotation;
    if (tool === "build" && part) {
      const def = BY_KEY[key];
      if (def.category === "Mechanics") {
        const targets = connectorList(part).filter(
          (c) => !["stud", "socket"].includes(c.type),
        );
        const fits: { position: Position; rotation: number; score: number }[] =
          [];
        for (let rot = 0; rot < 4; rot++) {
          const origin: Part = {
            id: "preview",
            key,
            color,
            position: { x: 0, y: 0, z: 0 },
            rotation: rot,
            revision: 0,
          };
          for (const local of connectorList(origin))
            for (const target of targets) {
              if (!mating({ ...local, at: target.at }, target)) continue;
              const position = {
                  x: target.at.x - local.at.x,
                  y: target.at.y - local.at.y,
                  z: target.at.z - local.at.z,
                },
                candidate = { ...origin, position };
              if (!validPart(candidate) || collision(candidate, part)) continue;
              fits.push({
                position,
                rotation: rot,
                score:
                  new THREE.Vector3(
                    target.at.x / 6,
                    target.at.y / 6,
                    target.at.z / 6,
                  ).distanceToSquared(point) + (rot === rotation ? 0 : 0.001),
              });
            }
        }
        const fit = fits.sort((a, b) => a.score - b.score)[0];
        if (fit) {
          Object.assign(next, fit.position);
          r = fit.rotation;
        }
      }
    }
    if (r !== rotation) setRotation(r);
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
    if (!ghosts.length || !canEdit) return;
    if (!valid) {
      notice("That space is occupied or outside the workbench.");
      return;
    }
    let accepted = false;
    if (tool === "build") {
      const id = crypto.randomUUID();
      accepted = await submit({
        action: "edit",
        changes: [{ id, ...ghosts[0] }],
      });
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
    if (selection.length && tool === "select" && canEdit)
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
          <span className="room-subtitle">A shared workbench</span>
          {roomMenu && (
            <div className="popover room-popover">
              <div className="popover-heading">MAKE ROOM FOR AN IDEA</div>
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
        <button className="invite-button" onClick={() => void invite()}>
          {copied ? <Check size={16} /> : <Link2 size={16} />}
          <span>{copied ? "Link copied" : "Invite a friend"}</span>
        </button>
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
      <div className="workspace">
        <aside className="drawer">
          <div className="drawer-heading">
            <div>
              <span className="eyebrow">GOOD THINGS COME IN PIECES</span>
              <h1>
                The parts drawer<span>.</span>
              </h1>
            </div>
            <span className="count-badge">36</span>
          </div>
          <div className="search">
            <Search size={16} />
            <input
              aria-label="Search parts"
              placeholder="Find your next piece…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            {search && (
              <button aria-label="Clear search" onClick={() => setSearch("")}>
                <X size={13} />
              </button>
            )}
            <span className="search-shortcut">⌕</span>
          </div>
          <div className="categories">
            {[
              { name: "All", icon: Blocks },
              { name: "Bricks", icon: Box },
              { name: "Plates", icon: Layers3 },
              { name: "Mechanics", icon: Cog },
            ].map(({ name, icon: Icon }) => (
              <button
                key={name}
                className={category === name ? "chosen" : ""}
                onClick={() => setCategory(name)}
                title={name}
              >
                <Icon size={15} />
                <span>{name}</span>
              </button>
            ))}
          </div>
          <div className="parts-list">
            <div className="section-label">
              <span>
                {category === "All"
                  ? "A LITTLE OF EVERYTHING"
                  : category.toUpperCase()}
              </span>
              <span>{filtered.length} pieces</span>
            </div>
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
                    <Thumb def={d} />
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
              <span>A SPLASH OF COLOUR</span>
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
            <div className="drawer-footnote">
              <i />
              36 pieces. Infinite possibilities.
            </div>
          </div>
        </aside>
        <main className="stage">
          <Scene
            parts={parts}
            selected={selected}
            ghosts={ghosts}
            valid={valid}
            viewers={remote}
            guest={getViewerId()}
            generation={state.world?.generation || 1}
            grid={grid}
            quality={quality}
            cameraMode={camera}
            presentation={presentation}
            onMetrics={inspector ? setMetrics : undefined}
            onHover={hover}
            onClick={(p, shift) => void click(p, shift)}
          />
          {welcome &&
            !presentation &&
            tool === "select" &&
            !selection.length && (
              <div className="welcome-note">
                <div className="eyebrow">
                  <span className="tiny-spark">✳</span> A LITTLE WORLD, BUILT
                  TOGETHER
                </div>
                <h2>
                  Make something
                  <br />
                  <em>wonderful.</em>
                </h2>
                <p>
                  Pick a piece. Find its place.
                  <br />
                  Leave a little room for someone else's idea.
                </p>
                <button
                  onClick={() => {
                    beginBuild(BY_KEY["brick-2x4"]);
                  }}
                  className="text-link"
                >
                  Let’s build
                  <ArrowUpRight size={15} />
                </button>
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
            <div className="view-label">YOUR PERSPECTIVE</div>
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
          {!presentation && selection.length > 0 && tool === "select" && (
            <div className="selection-card">
              <div className="selection-heading">
                <span className="eyebrow">ON YOUR WORKBENCH</span>
                <button
                  aria-label="Clear selection"
                  onClick={() => setSelected([])}
                >
                  <X size={14} />
                </button>
              </div>
              <h3>
                {selection.length === 1
                  ? BY_KEY[selection[0].key]?.name
                  : `${selection.length} pieces selected`}
              </h3>
              <p>
                {selection.length === 1
                  ? `Revision ${selection[0].revision} · ${selectedConnections(selectionIds).length} connections`
                  : "Move and edit these pieces together."}
              </p>
              <div className="selection-actions">
                <button onClick={() => beginMove()} disabled={!canEdit}>
                  <Move size={15} />
                  Move
                </button>
                <button onClick={() => beginMove(true)} disabled={!canEdit}>
                  <Copy size={15} />
                  Copy
                </button>
                <button
                  onClick={() => void remove()}
                  disabled={!canEdit}
                  aria-label="Delete selection"
                >
                  <Trash2 size={15} />
                </button>
              </div>
            </div>
          )}
          {!presentation && (
            <div className="layer-control">
              <div className="layer-icon">
                <Layers3 size={17} />
              </div>
              <div>
                <span className="eyebrow">BUILD LAYER</span>
                <div className="layer-row">
                  <button
                    title="Lower build layer"
                    onClick={() => {
                      setAutoHeight(false);
                      setLayer((v) => Math.max(0, v - 1));
                    }}
                  >
                    <Minus size={13} />
                  </button>
                  <button
                    className="layer-value"
                    onClick={() => setAutoHeight((v) => !v)}
                    title="Toggle automatic height"
                  >
                    {autoHeight ? "Auto" : `${layer} plates`}
                  </button>
                  <button
                    title="Raise build layer"
                    onClick={() => {
                      setAutoHeight(false);
                      setLayer((v) => v + 1);
                    }}
                  >
                    <Plus size={13} />
                  </button>
                </div>
              </div>
            </div>
          )}
          {!presentation && (
            <div className="build-hint">
              {tool === "build" ? (
                <>
                  <span className={`hint-dot ${valid ? "" : "invalid"}`} />
                  {BY_KEY[key].name}
                  <span className="hint-divider" />
                  <kbd>R</kbd> rotate<kbd>esc</kbd> cancel
                </>
              ) : tool === "move" || tool === "duplicate" ? (
                <>
                  <Move size={14} />
                  Choose a new home for {selection.length}{" "}
                  {selection.length === 1 ? "piece" : "pieces"}
                  <kbd>esc</kbd> cancel
                </>
              ) : (
                <>
                  <MousePointer2 size={14} />
                  Drag to orbit
                  <span className="hint-divider" />
                  Shift-click to select more
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
                <span className="presentation-label">
                  A little world, built together
                </span>
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
          <div className="stage-options">
            <button
              className={grid ? "active" : ""}
              aria-label="Toggle construction grid"
              title="Construction grid"
              onClick={() => setGrid((v) => !v)}
            >
              <Grid3X3 size={16} />
            </button>
            <button
              className={quality ? "active" : ""}
              aria-label="Toggle reduced quality"
              title="Reduced quality for smaller devices"
              onClick={() => setQuality((v) => !v)}
            >
              <SlidersHorizontal size={16} />
            </button>
            <button
              className={inspector ? "active" : ""}
              aria-label="Demo inspector"
              title="Demo inspector"
              onClick={() => setInspector((v) => !v)}
            >
              <PanelRight size={16} />
            </button>
          </div>
          {inspector && (
            <div className="inspector">
              <div className="eyebrow">DEMO INSPECTOR</div>
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
                    <dd data-testid="frame-p95">{metrics.p95.toFixed(1)} ms</dd>
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
            </div>
          )}
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
                ? "Saving your idea…"
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
        <span className="footer-message">
          A place for small pieces and big ideas.
        </span>
        <a
          href="https://neon.com"
          target="_blank"
          rel="noreferrer"
          className="powered"
        >
          Built together with
          <span className="neon-word">
            neon
            <ArrowUpRight size={11} />
          </span>
        </a>
      </footer>
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
            <span className="eyebrow">WELCOME TO YOUR LITTLE WORKSHOP</span>
            <h2>Ideas click together.</h2>
            <p>
              Choose a piece from the drawer and click the workbench to place
              it. Green means it fits. Your friends see it as soon as it’s
              saved.
            </p>
            <div className="help-rows">
              <div>
                <kbd>drag</kbd>
                <span>
                  Orbit the camera. Right-drag to pan, scroll to zoom.
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
                <span>Move your selection. ⌘D makes a copy.</span>
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
              Make something wonderful
              <ArrowUpRight size={16} />
            </button>
          </section>
        </div>
      )}
    </div>
  );
}
