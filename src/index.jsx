import { createRoot } from "react-dom/client";
import { useReducer, useState, useRef, useEffect, useCallback } from "react";
import {
	DndContext,
	DragOverlay,
	PointerSensor,
	useSensor,
	useSensors,
	useDraggable,
	useDroppable,
	pointerWithin,
} from "@dnd-kit/core";
import {
	WIDGETS,
	createNode,
	findNode,
	findParent,
	updateNode,
	insertNode,
	removeNode,
	moveNode,
	moveNodeWrapped,
	depthOf,
	subtreeHeight,
} from "./tree.js";

const BOTTOM_ZONE = "__bottom__";

const BOOT = window.MERAKI_BUILDER;
const MAX_DEPTH = BOOT.maxDepth || 10;

/* ------------------------------------------------------------------ state */
/* History lives on the immutable tree: past/present/future snapshots of
   { tree, selectedId }. Text typing coalesces per field (coalesceKey);
   selection changes never create history. Capped at 100 steps. */

const HISTORY_CAP = 100;

function withHistory(state, tree, selectedId, coalesceKey = null) {
	if (tree === state.present.tree) {
		return { ...state, present: { ...state.present, selectedId } };
	}
	const coalesce = coalesceKey && state.lastCoalesceKey === coalesceKey && state.past.length > 0;
	return {
		...state,
		past: coalesce ? state.past : [...state.past.slice(-(HISTORY_CAP - 1)), state.present],
		future: [],
		present: { tree, selectedId },
		lastCoalesceKey: coalesceKey,
		dirty: JSON.stringify(tree) !== state.savedJson,
	};
}

function reducer(state, action) {
	const { tree, selectedId } = state.present;
	switch (action.type) {
		case "insert": {
			const node = action.node;
			return withHistory(state, insertNode(tree, action.parentId, action.index, node), action.selectId || node.id);
		}
		case "move":
			return withHistory(state, moveNode(tree, action.id, action.parentId, action.index), selectedId);
		case "moveWrap":
			return withHistory(state, moveNodeWrapped(tree, action.id, action.parentId, action.index, action.wrapper), selectedId);
		case "props":
			return withHistory(
				state,
				updateNode(tree, action.id, (n) => ({ ...n, props: { ...n.props, ...action.patch } })),
				selectedId,
				action.coalesce ? `props:${action.id}:${action.coalesce}` : null
			);
		case "css":
			return withHistory(
				state,
				updateNode(tree, action.id, (n) => ({ ...n, css: action.css })),
				selectedId,
				`css:${action.id}`
			);
		case "delete": {
			const { root } = removeNode(tree, action.id);
			return withHistory(state, root, selectedId === action.id ? null : selectedId);
		}
		case "select":
			return { ...state, present: { ...state.present, selectedId: action.id }, lastCoalesceKey: null };
		case "commit":
			return { ...state, lastCoalesceKey: null };
		case "undo": {
			if (!state.past.length) return state;
			const prev = state.past[state.past.length - 1];
			return {
				...state,
				past: state.past.slice(0, -1),
				future: [state.present, ...state.future],
				present: prev,
				lastCoalesceKey: null,
				dirty: JSON.stringify(prev.tree) !== state.savedJson,
			};
		}
		case "redo": {
			if (!state.future.length) return state;
			const next = state.future[0];
			return {
				...state,
				past: [...state.past, state.present],
				future: state.future.slice(1),
				present: next,
				lastCoalesceKey: null,
				dirty: JSON.stringify(next.tree) !== state.savedJson,
			};
		}
		case "title":
			return { ...state, title: action.title, titleDirty: true };
		case "saved":
			return { ...state, savedJson: JSON.stringify(tree), dirty: false, titleDirty: false };
		default:
			return state;
	}
}

const initialTree = BOOT.tree || createNode("container");
const initialState = {
	present: { tree: initialTree, selectedId: null },
	past: [],
	future: [],
	lastCoalesceKey: null,
	title: BOOT.title || "",
	savedJson: JSON.stringify(initialTree),
	dirty: false,
	titleDirty: false,
};

/* ------------------------------------------------------------------- app */

function App() {
	const [state, dispatch] = useReducer(reducer, initialState);
	const { title, past, future } = state;
	const { tree, selectedId } = state.present;
	const isDirty = state.dirty || state.titleDirty;

	const [active, setActive] = useState(null); // { kind, widgetType?, nodeId? }
	const [target, setTarget] = useState(null); // { parentId, index, line?, insideRow? }
	const [hoveredId, setHoveredId] = useState(null);
	const [collapsed, setCollapsed] = useState(() => new Set());
	const [tab, setTab] = useState("block");
	const [saveState, setSaveState] = useState("idle"); // idle | saving | saved | error

	const nodeEls = useRef(new Map());
	const rowEls = useRef(new Map());
	const pointer = useRef({ x: 0, y: 0 });
	const treeRef = useRef(tree);
	treeRef.current = tree;

	useEffect(() => {
		window.__mbTree = tree; // verification hook (editor only)
	}, [tree]);

	const registerEl = useCallback((id, el) => {
		if (el) nodeEls.current.set(id, el);
		else nodeEls.current.delete(id);
	}, []);

	const registerRow = useCallback((id, el) => {
		if (el) rowEls.current.set(id, el);
		else rowEls.current.delete(id);
	}, []);

	const selectAndReveal = useCallback((id) => {
		dispatch({ type: "select", id });
		nodeEls.current.get(id)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
	}, []);

	const toggleCollapsed = useCallback((id) => {
		setCollapsed((prev) => {
			const next = new Set(prev);
			next.has(id) ? next.delete(id) : next.add(id);
			return next;
		});
	}, []);

	// Handle-bar "+": one click, one empty sibling container right after
	// this node (inside the same parent — sibling, never root-hoisted).
	const addSiblingAfter = useCallback((nodeId) => {
		const t = treeRef.current;
		const parent = findParent(t, nodeId);
		if (!parent) return;
		const idx = parent.children.findIndex((c) => c.id === nodeId);
		dispatch({ type: "insert", parentId: parent.id, index: idx + 1, node: createNode("container") });
	}, []);

	// Page appender: one empty full-width section at the end of the page.
	const addSection = useCallback(() => {
		const t = treeRef.current;
		dispatch({ type: "insert", parentId: t.id, index: t.children.length, node: createNode("container") });
	}, []);

	const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

	/* ---------------------------------------------------------- dnd rules */

	const validContainer = useCallback(
		(containerId, drag) => {
			const t = treeRef.current;
			if (containerId === BOTTOM_ZONE) return true; // always targets root level

			const container = findNode(t, containerId);
			if (!container || container.type !== "container") return false;
			const depth = depthOf(t, containerId);
			if (drag.kind === "palette") {
				const height = drag.widgetType === "container" ? 2 : 1;
				return depth + height <= MAX_DEPTH;
			}
			if (drag.nodeId === containerId) return false;
			const dragged = findNode(t, drag.nodeId);
			if (!dragged || findNode(dragged, containerId)) return false; // own subtree
			return depth + subtreeHeight(dragged) <= MAX_DEPTH;
		},
		[]
	);

	const collisionDetection = useCallback(
		(args) => {
			const drag = args.active.data.current;
			const within = pointerWithin(args);

			// Tree rows win when the pointer is over the tree panel; validity
			// is decided in resolveTreeTarget so invalid rows still give
			// "invalid" feedback instead of falling through to the canvas.
			const rows = within.filter((c) => String(c.id).startsWith("trow:"));
			if (rows.length) return [rows[0]];

			// Tree-originated drags only target tree rows.
			if (drag.kind === "tree") return [];

			const hits = within.filter((c) => validContainer(String(c.id), drag));
			if (!hits.length) return [];
			hits.sort((a, b) => depthOf(treeRef.current, String(b.id)) - depthOf(treeRef.current, String(a.id)));
			return [hits[0]];
		},
		[validContainer]
	);

	const computeTarget = useCallback((containerId, forcedIndex) => {
		const container = findNode(treeRef.current, containerId);
		const el = nodeEls.current.get(containerId);
		if (!container || !el) return null;

		const rect = el.getBoundingClientRect();
		const row = container.props.direction === "row";
		const kids = container.children
			.map((c) => ({ id: c.id, rect: nodeEls.current.get(c.id)?.getBoundingClientRect() }))
			.filter((k) => k.rect);

		let index = kids.length;
		for (let i = 0; i < kids.length; i++) {
			const mid = row ? (kids[i].rect.left + kids[i].rect.right) / 2 : (kids[i].rect.top + kids[i].rect.bottom) / 2;
			if ((row ? pointer.current.x : pointer.current.y) < mid) {
				index = i;
				break;
			}
		}
		if (typeof forcedIndex === "number") index = Math.max(0, Math.min(forcedIndex, kids.length));

		const pad = 6;
		let line;
		if (!kids.length) {
			line = row
				? { x: rect.left + pad, y: rect.top + pad, w: 3, h: rect.height - pad * 2 }
				: { x: rect.left + pad, y: rect.top + pad, w: rect.width - pad * 2, h: 3 };
		} else if (row) {
			const x =
				index === 0
					? kids[0].rect.left - 3
					: index === kids.length
					? kids[kids.length - 1].rect.right + 1
					: (kids[index - 1].rect.right + kids[index].rect.left) / 2;
			line = { x, y: rect.top + pad, w: 3, h: rect.height - pad * 2 };
		} else {
			const y =
				index === 0
					? kids[0].rect.top - 3
					: index === kids.length
					? kids[kids.length - 1].rect.bottom + 1
					: (kids[index - 1].rect.bottom + kids[index].rect.top) / 2;
			line = { x: rect.left + pad, y, w: rect.width - pad * 2, h: 3 };
		}

		return { parentId: containerId, index, line };
	}, []);

	/**
	 * Deepest-container targeting, with edge zones: hovering near a
	 * child container's leading/trailing edge inserts a SIBLING into
	 * its parent instead of nesting — otherwise a child that fills its
	 * parent would swallow every drop.
	 */
	/**
	 * Tree-row targets. Stricter than the canvas: root accepts only
	 * containers and there is NO auto-wrap — invalid drops resolve to
	 * null, which reads as "invalid" on the drag chip.
	 */
	const resolveTreeTarget = useCallback(
		(nodeId, drag) => {
			const t = treeRef.current;
			const node = findNode(t, nodeId);
			const el = rowEls.current.get(nodeId);
			if (!node || !el) return null;

			const draggedType = drag.kind === "palette" ? drag.widgetType : findNode(t, drag.nodeId)?.type;
			const r = el.getBoundingClientRect();
			const y = pointer.current.y;
			const isCont = node.type === "container";
			const zone = isCont
				? y < r.top + r.height * 0.3
					? "before"
					: y > r.bottom - r.height * 0.3
					? "after"
					: "inside"
				: y < r.top + r.height / 2
				? "before"
				: "after";

			if (zone === "inside") {
				if (!validContainer(node.id, drag)) return null;
				if (node.id === t.id && draggedType !== "container") return null; // root rule, no wrap
				return { parentId: node.id, index: node.children.length, insideRow: node.id };
			}

			if (node.id === t.id) return null; // root row only accepts "inside"
			const parent = findParent(t, nodeId);
			if (!parent || !validContainer(parent.id, drag)) return null;
			if (parent.id === t.id && draggedType !== "container") return null; // root rule, no wrap

			const idx = parent.children.findIndex((c) => c.id === nodeId) + (zone === "after" ? 1 : 0);
			return {
				parentId: parent.id,
				index: idx,
				line: { x: r.left + 4, y: zone === "before" ? r.top - 1 : r.bottom - 2, w: r.width - 8, h: 3 },
			};
		},
		[validContainer]
	);

	const resolveTarget = useCallback(
		(overId, drag) => {
			const t = treeRef.current;

			if (overId.startsWith("trow:")) {
				return resolveTreeTarget(overId.slice(5), drag);
			}

			// The persistent bottom zone always appends at root level.
			if (overId === BOTTOM_ZONE) {
				const el = nodeEls.current.get(BOTTOM_ZONE);
				if (!el) return null;
				const r = el.getBoundingClientRect();
				return { parentId: t.id, index: t.children.length, line: { x: r.left + 6, y: r.top + 6, w: r.width - 12, h: 3 } };
			}

			const parent = findParent(t, overId);
			if (parent && parent.type === "container" && validContainer(parent.id, drag)) {
				const el = nodeEls.current.get(overId);
				if (el) {
					const r = el.getBoundingClientRect();
					const row = parent.props.direction === "row";
					const p = row ? pointer.current.x : pointer.current.y;
					const start = row ? r.left : r.top;
					const end = row ? r.right : r.bottom;
					// Generous zones: landing as a sibling is the easy gesture,
					// nesting the deliberate one. Roomiest at root level.
					const cap = parent.id === t.id ? 40 : 28;
					const edge = Math.min(cap, (end - start) / 3);
					const idx = parent.children.findIndex((c) => c.id === overId);
					if (p < start + edge) return computeTarget(parent.id, idx);
					if (p > end - edge) return computeTarget(parent.id, idx + 1);
				}
			}
			return computeTarget(overId);
		},
		[computeTarget, validContainer, resolveTreeTarget]
	);

	const onDragStart = (event) => {
		setActive(event.active.data.current);
		const ae = event.active.data.current?.activatorEvent || event.activatorEvent;
		if (ae && "clientX" in ae) pointer.current = { x: ae.clientX, y: ae.clientY };
	};

	const onDragMove = (event) => {
		const ae = event.activatorEvent;
		if (ae && "clientX" in ae) {
			pointer.current = { x: ae.clientX + event.delta.x, y: ae.clientY + event.delta.y };
		}
		setTarget(event.over ? resolveTarget(String(event.over.id), event.active.data.current) : null);
	};

	const onDragEnd = (event) => {
		const drag = event.active.data.current;
		const drop = event.over ? resolveTarget(String(event.over.id), drag) : null;
		setActive(null);
		setTarget(null);
		if (!drop || !drag) return;

		const t = treeRef.current;
		const atRoot = drop.parentId === t.id;

		if (drag.kind === "palette") {
			const node = createNode(drag.widgetType);
			if (atRoot && drag.widgetType !== "container") {
				// Root invariant: non-containers get auto-wrapped; select the
				// widget the user actually dropped.
				const wrapper = createNode("container");
				wrapper.children = [node];
				dispatch({ type: "insert", parentId: drop.parentId, index: drop.index, node: wrapper, selectId: node.id });
			} else {
				dispatch({ type: "insert", parentId: drop.parentId, index: drop.index, node });
			}
		} else if (drag.kind === "node" || drag.kind === "tree") {
			const dragged = findNode(t, drag.nodeId);
			// Auto-wrap applies to CANVAS root drops only; tree targets have
			// already rejected root-level non-containers in resolveTreeTarget.
			if (atRoot && !drop.insideRow && drag.kind === "node" && dragged && dragged.type !== "container") {
				dispatch({ type: "moveWrap", id: drag.nodeId, parentId: drop.parentId, index: drop.index, wrapper: createNode("container") });
			} else {
				dispatch({ type: "move", id: drag.nodeId, parentId: drop.parentId, index: drop.index });
			}
		}
	};

	/* ------------------------------------------------------ delete + save */

	useEffect(() => {
		const onKey = (e) => {
			const t = e.target;
			const typing = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);

			const mod = e.metaKey || e.ctrlKey;
			if (mod && !typing && e.key.toLowerCase() === "z") {
				e.preventDefault();
				dispatch({ type: e.shiftKey ? "redo" : "undo" });
				return;
			}
			if (mod && !typing && e.key.toLowerCase() === "y") {
				e.preventDefault();
				dispatch({ type: "redo" });
				return;
			}

			if (e.key !== "Delete" && e.key !== "Backspace") return;
			if (typing) return;
			if (selectedId && selectedId !== tree.id) {
				e.preventDefault();
				dispatch({ type: "delete", id: selectedId });
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [selectedId, tree.id]);

	const save = async () => {
		setSaveState("saving");
		try {
			const res = await fetch(BOOT.restUrl, {
				method: "POST",
				headers: { "Content-Type": "application/json", "X-WP-Nonce": BOOT.nonce },
				credentials: "same-origin",
				body: JSON.stringify({ post: BOOT.post, tree, title }),
			});
			if (!res.ok) throw new Error("HTTP " + res.status);
			dispatch({ type: "saved" });
			setSaveState("saved");
			setTimeout(() => setSaveState("idle"), 2000);
		} catch (err) {
			setSaveState("error");
		}
	};

	const selected = selectedId ? findNode(tree, selectedId) : null;

	return (
		<DndContext
			sensors={sensors}
			collisionDetection={collisionDetection}
			onDragStart={onDragStart}
			onDragMove={onDragMove}
			onDragEnd={onDragEnd}
			onDragCancel={() => {
				setActive(null);
				setTarget(null);
			}}
		>
			<div className="mb-app">
				<header className="mb-topbar">
					<div className="mb-topbar-brand">
						<strong>Meraki Builder</strong>
						<span className="mb-topbar-title">{title || "(untitled)"}</span>
					</div>
					<div className="mb-topbar-actions">
						<button type="button" className="mb-btn mb-btn-quiet mb-btn-history" data-testid="undo" title="Undo (⌘Z)" disabled={!past.length} onClick={() => dispatch({ type: "undo" })}>
							↶
						</button>
						<button type="button" className="mb-btn mb-btn-quiet mb-btn-history" data-testid="redo" title="Redo (⇧⌘Z)" disabled={!future.length} onClick={() => dispatch({ type: "redo" })}>
							↷
						</button>
						<span className={"mb-save-note mb-save-" + saveState} data-testid="save-state">
							{saveState === "saving" ? "Saving…" : saveState === "saved" ? "Saved" : saveState === "error" ? "Save failed" : isDirty ? "Unsaved changes" : ""}
						</span>
						<button type="button" className="mb-btn mb-btn-primary" data-testid="save" onClick={save} disabled={saveState === "saving"}>
							Save
						</button>
						<a className="mb-btn mb-btn-quiet" href={BOOT.exitUrl} title="Exit to WordPress" data-testid="exit">
							✕
						</a>
					</div>
				</header>

				<div className="mb-body">
					<aside className="mb-panel mb-left">
						<div className="mb-left-widgets">
							<h2 className="mb-panel-heading">Widgets</h2>
							<div className="mb-palette">
								{Object.entries(WIDGETS).map(([type, def]) => (
									<PaletteItem key={type} type={type} label={def.label} />
								))}
							</div>
						</div>
						<div className="mb-left-tree" onPointerLeave={() => setHoveredId(null)}>
							<h2 className="mb-panel-heading">Tree</h2>
							<TreePanel
								tree={tree}
								selectedId={selectedId}
								hoveredId={hoveredId}
								collapsed={collapsed}
								insideRow={target?.insideRow}
								onToggle={toggleCollapsed}
								onHover={setHoveredId}
								onSelect={selectAndReveal}
								dispatch={dispatch}
								registerRow={registerRow}
							/>
						</div>
					</aside>

					<div
						className="mb-canvas"
						data-testid="canvas"
						onClick={() => dispatch({ type: "select", id: null })}
						onPointerLeave={() => setHoveredId(null)}
					>
						<main className="site-main mb-canvas-main">
							<article>
								<div className="entry-content">
									<NodeView
										node={tree}
										rootId={tree.id}
										selectedId={selectedId}
										hoveredId={hoveredId}
										dragActive={!!active}
										onHover={setHoveredId}
										addSiblingAfter={addSiblingAfter}
										dispatch={dispatch}
										registerEl={registerEl}
									/>
									<BottomZone registerEl={registerEl} onAddSection={addSection} />
								</div>
							</article>
						</main>
					</div>

					<aside className="mb-panel mb-right">
						<div className="mb-tabs" role="tablist">
							<button type="button" role="tab" aria-selected={tab === "block"} className={tab === "block" ? "is-active" : ""} onClick={() => setTab("block")} data-testid="tab-block">
								Block
							</button>
							<button type="button" role="tab" aria-selected={tab === "page"} className={tab === "page" ? "is-active" : ""} onClick={() => setTab("page")} data-testid="tab-page">
								Page
							</button>
						</div>
						{tab === "block" ? (
							<BlockTab node={selected} isRoot={selected?.id === tree.id} dispatch={dispatch} />
						) : (
							<PageTab title={title} dispatch={dispatch} />
						)}
					</aside>
				</div>
			</div>

			{target && target.line && active && (
				<div
					className={"mb-indicator " + (target.line.w >= target.line.h ? "mb-indicator-h" : "mb-indicator-v")}
					data-testid="indicator"
					style={{ left: target.line.x, top: target.line.y, width: target.line.w, height: target.line.h }}
				/>
			)}

			<DragOverlay dropAnimation={null}>
				{active ? (
					<div className={"mb-drag-chip" + (target ? "" : " is-invalid")} data-testid="drag-chip">
						{active.kind === "palette" ? WIDGETS[active.widgetType].label : nodeLabel(findNode(tree, active.nodeId))}
					</div>
				) : null}
			</DragOverlay>
		</DndContext>
	);
}

const nodeLabel = (node) =>
	!node ? "" : node.type === "container" ? "Container" : `Text (${node.props.tag})`;

/* --------------------------------------------------------------- palette */

function PaletteItem({ type, label }) {
	const { setNodeRef, listeners, attributes } = useDraggable({
		id: "palette:" + type,
		data: { kind: "palette", widgetType: type },
	});
	return (
		<div ref={setNodeRef} {...listeners} {...attributes} className="mb-widget-card" data-testid={"palette-" + type}>
			<span className="mb-widget-icon" aria-hidden="true">
				{type === "container" ? "▦" : "¶"}
			</span>
			{label}
		</div>
	);
}

/* ------------------------------------------------------------------ tree */

function TreePanel(props) {
	const rows = [];
	const walk = (node, depth) => {
		rows.push(<TreeRow key={node.id} node={node} depth={depth} {...props} />);
		if (node.type === "container" && !props.collapsed.has(node.id)) {
			node.children.forEach((child) => walk(child, depth + 1));
		}
	};
	walk(props.tree, 0);
	return (
		<div className="mb-tree" data-testid="tree">
			{rows}
		</div>
	);
}

function TreeRow({ node, depth, tree, selectedId, hoveredId, collapsed, insideRow, onToggle, onHover, onSelect, dispatch, registerRow }) {
	const isRoot = node.id === tree.id;
	const isContainer = node.type === "container";

	const { setNodeRef: setDragRef, listeners, attributes } = useDraggable({
		id: "tree:" + node.id,
		data: { kind: "tree", nodeId: node.id },
		disabled: isRoot,
	});
	const { setNodeRef: setDropRef } = useDroppable({ id: "trow:" + node.id });

	const ref = (el) => {
		setDragRef(el);
		setDropRef(el);
		registerRow(node.id, el);
	};

	const label = isRoot
		? "Page"
		: isContainer
		? "Container"
		: (node.props.content || "").slice(0, 26) + ((node.props.content || "").length > 26 ? "…" : "");

	const cls =
		"mb-trow" +
		(selectedId === node.id ? " is-selected" : "") +
		(hoveredId === node.id ? " is-hovered" : "") +
		(insideRow === node.id ? " is-drop-inside" : "");

	return (
		<div
			ref={ref}
			className={cls}
			style={{ paddingLeft: depth * 14 + 6 }}
			data-testid={"trow-" + node.id}
			onClick={(e) => {
				e.stopPropagation();
				onSelect(node.id);
			}}
			onPointerOver={(e) => {
				e.stopPropagation();
				onHover(node.id);
			}}
			{...listeners}
			{...attributes}
		>
			{isContainer ? (
				<button
					type="button"
					className="mb-trow-chevron"
					data-testid={"chevron-" + node.id}
					onPointerDown={(e) => e.stopPropagation()}
					onClick={(e) => {
						e.stopPropagation();
						onToggle(node.id);
					}}
					aria-label={collapsed.has(node.id) ? "Expand" : "Collapse"}
				>
					{collapsed.has(node.id) ? "▸" : "▾"}
				</button>
			) : (
				<span className="mb-trow-dot" aria-hidden="true">
					¶
				</span>
			)}
			<span className={"mb-trow-label" + (isContainer ? " is-type" : "")}>{label}</span>
			{!isRoot && (
				<button
					type="button"
					className="mb-trow-del"
					data-testid={"trow-del-" + node.id}
					title="Delete"
					onPointerDown={(e) => e.stopPropagation()}
					onClick={(e) => {
						e.stopPropagation();
						dispatch({ type: "delete", id: node.id });
					}}
				>
					×
				</button>
			)}
		</div>
	);
}

/* ---------------------------------------------------------------- canvas */

function BottomZone({ registerEl, onAddSection }) {
	const { setNodeRef, isOver } = useDroppable({ id: BOTTOM_ZONE });
	const ref = (el) => {
		setNodeRef(el);
		registerEl(BOTTOM_ZONE, el);
	};
	return (
		<button
			type="button"
			ref={ref}
			className={"mb-appender" + (isOver ? " is-over" : "")}
			data-testid="bottom-zone"
			onClick={(e) => {
				e.stopPropagation();
				onAddSection();
			}}
		>
			<span className="mb-appender-plus" aria-hidden="true">+</span> Add Section
		</button>
	);
}

function HandleBar({ node, isContainer, onAddSibling, onDelete }) {
	const stop = (e) => e.stopPropagation();
	return (
		<div className="mb-handlebar" data-testid={"handlebar-" + node.id}>
			<span className="mb-hb-grip" aria-hidden="true" title="Drag to move">⠿</span>
			<span className="mb-hb-label">{isContainer ? "Container" : "Text"}</span>
			{isContainer && (
				<button
					type="button"
					title="Add sibling container after"
					data-testid="hb-add"
					onPointerDown={stop}
					onClick={(e) => {
						stop(e);
						onAddSibling();
					}}
				>
					+
				</button>
			)}
			<button
				type="button"
				title="Delete"
				data-testid="hb-delete"
				onPointerDown={stop}
				onClick={(e) => {
					stop(e);
					onDelete();
				}}
			>
				×
			</button>
		</div>
	);
}

function NodeView({ node, rootId, selectedId, hoveredId, dragActive, onHover, addSiblingAfter, dispatch, registerEl }) {
	const isRoot = node.id === rootId;
	const isContainer = node.type === "container";

	const { setNodeRef: setDragRef, listeners, attributes, isDragging } = useDraggable({
		id: "node:" + node.id,
		data: { kind: "node", nodeId: node.id },
		disabled: isRoot,
	});
	const { setNodeRef: setDropRef } = useDroppable({ id: node.id, disabled: !isContainer });

	const ref = (el) => {
		setDragRef(el);
		if (isContainer) setDropRef(el);
		registerEl(node.id, el);
	};

	const onClick = (e) => {
		e.stopPropagation();
		dispatch({ type: "select", id: node.id });
	};

	// Innermost-only hover: children stop propagation so only the deepest
	// node under the pointer carries the affordances.
	const onPointerOver = (e) => {
		e.stopPropagation();
		onHover(isRoot ? null : node.id);
	};

	const showBar = !isRoot && !dragActive && (hoveredId === node.id || selectedId === node.id);
	const bar = showBar && (
		<HandleBar
			node={node}
			isContainer={isContainer}
			onAddSibling={() => addSiblingAfter(node.id)}
			onDelete={() => dispatch({ type: "delete", id: node.id })}
		/>
	);

	const editorCls =
		"mb-node" +
		(selectedId === node.id ? " is-selected" : "") +
		(!isRoot && hoveredId === node.id && !dragActive ? " is-hovered" : "") +
		(isDragging ? " is-ghost" : "");

	const childProps = { rootId, selectedId, hoveredId, dragActive, onHover, addSiblingAfter, dispatch, registerEl };

	if (isContainer) {
		const p = node.props;
		// The root is the page, never a width-constraining section.
		const width = isRoot ? "full" : p.width === "full" ? "full" : "contained";
		const pad = p.padding && p.padding !== "none" ? ` mb-pad-${p.padding}` : "";
		const cls = `${editorCls} m-${node.id} mb-container mb-${p.direction === "row" ? "row" : "column"} mb-gap-${p.gap} mb-${width}${pad}`;
		return (
			<div ref={ref} className={cls} data-mbid={node.id} onClick={onClick} onPointerOver={onPointerOver} {...listeners} {...attributes}>
				{bar}
				{node.children.length ? (
					node.children.map((child) => <NodeView key={child.id} node={child} {...childProps} />)
				) : isRoot ? null : (
					<div className="mb-empty">Drop widgets here</div>
				)}
			</div>
		);
	}

	const Tag = node.props.tag || "p";
	return (
		<Tag ref={ref} className={`${editorCls} m-${node.id}`} data-mbid={node.id} onClick={onClick} onPointerOver={onPointerOver} {...listeners} {...attributes}>
			{bar}
			{node.props.content}
		</Tag>
	);
}

/* -------------------------------------------------------------- inspector */

function Field({ label, children }) {
	return (
		<label className="mb-field">
			<span className="mb-field-label">{label}</span>
			{children}
		</label>
	);
}

function BlockTab({ node, isRoot, dispatch }) {
	if (!node) {
		return (
			<div className="mb-empty-state" data-testid="empty-state">
				<p>Select a block on the canvas to edit its settings, or drag a widget in from the left.</p>
			</div>
		);
	}

	const set = (patch) => dispatch({ type: "props", id: node.id, patch });

	return (
		<div className="mb-inspector" data-testid="inspector">
			<h2 className="mb-panel-heading">
				{nodeLabel(node)}
				{isRoot ? " (page root)" : ""}
			</h2>

			{node.type === "container" && (
				<>
					<Field label="Direction">
						<select name="direction" value={node.props.direction} onChange={(e) => set({ direction: e.target.value })}>
							<option value="column">Column</option>
							<option value="row">Row</option>
						</select>
					</Field>
					<Field label="Gap">
						<select name="gap" value={node.props.gap} onChange={(e) => set({ gap: e.target.value })}>
							<option value="none">None</option>
							<option value="sm">Small</option>
							<option value="md">Medium</option>
							<option value="lg">Large</option>
						</select>
					</Field>
					{!isRoot && (
						<Field label="Width">
							<select name="width" value={node.props.width} onChange={(e) => set({ width: e.target.value })}>
								<option value="full">Full</option>
								<option value="contained">Contained</option>
							</select>
						</Field>
					)}
					<Field label="Padding">
						<select name="padding" value={node.props.padding || "none"} onChange={(e) => set({ padding: e.target.value })}>
							<option value="none">None</option>
							<option value="sm">Small</option>
							<option value="md">Medium</option>
							<option value="lg">Large</option>
						</select>
					</Field>
				</>
			)}

			{node.type === "text" && (
				<>
					<Field label="Tag">
						<select name="tag" value={node.props.tag} onChange={(e) => set({ tag: e.target.value })}>
							{["h1", "h2", "h3", "h4", "h5", "h6", "p"].map((t) => (
								<option key={t} value={t}>
									{t}
								</option>
							))}
						</select>
					</Field>
					<Field label="Content">
						<textarea
							name="content"
							rows={4}
							value={node.props.content}
							onChange={(e) => dispatch({ type: "props", id: node.id, patch: { content: e.target.value }, coalesce: "content" })}
							onBlur={() => dispatch({ type: "commit" })}
						/>
					</Field>
				</>
			)}

			<Field label="Custom CSS">
				<textarea
					name="css"
					rows={5}
					placeholder={"selector {\n\t\n}"}
					value={node.css}
					onChange={(e) => dispatch({ type: "css", id: node.id, css: e.target.value })}
					onBlur={() => dispatch({ type: "commit" })}
				/>
			</Field>
			<p className="mb-hint">“selector” targets this block (.m-{node.id}). Empty = nothing shipped.</p>

			{!isRoot && (
				<button type="button" className="mb-btn mb-btn-danger" data-testid="delete-node" onClick={() => dispatch({ type: "delete", id: node.id })}>
					Delete block
				</button>
			)}
		</div>
	);
}

function PageTab({ title, dispatch }) {
	return (
		<div className="mb-inspector" data-testid="page-tab">
			<h2 className="mb-panel-heading">Page</h2>
			<Field label="Title">
				<input name="page-title" type="text" value={title} onChange={(e) => dispatch({ type: "title", title: e.target.value })} />
			</Field>
			<p className="mb-hint">Page-level settings will live here in a future release.</p>
		</div>
	);
}

createRoot(document.getElementById("mb-root")).render(<App />);
