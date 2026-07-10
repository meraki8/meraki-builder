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
	compileStyles,
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
		case "styles":
			// Generated-styles pipeline: patch styles, optionally clearing a
			// legacy prop in the same (single) history step.
			return withHistory(
				state,
				updateNode(tree, action.id, (n) => ({
					...n,
					styles: { ...(n.styles || {}), ...action.patch },
					props: action.alsoProps ? { ...n.props, ...action.alsoProps } : n.props,
				})),
				selectedId,
				action.coalesce ? `styles:${action.id}:${action.coalesce}` : null
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

					{/* generated styles mirrored live; scoped under .mb-canvas so
					    they outrank the editor's base container padding */}
					<style data-testid="canvas-styles">{compileStyles(tree, ".mb-canvas ").join("\n")}</style>
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
		// Absent layout = flex (pre-0.3.0 trees) — emits exactly the legacy classes.
		const layout = !isRoot && (p.layout === "div" || p.layout === "grid") ? p.layout : "flex";
		const layoutCls =
			layout === "flex"
				? ` mb-${p.direction === "row" ? "row" : "column"} mb-gap-${p.gap}`
				: layout === "grid"
				? ` mb-grid mb-gap-${p.gap}`
				: " mb-div";
		const cls = `${editorCls} m-${node.id} mb-container${layoutCls} mb-${width}${pad}`;
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

/* ------------------------------------------------------------------ icons */

const I = (paths) => (
	<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
		{paths}
	</svg>
);
const IconBox = () => I(<rect x="3" y="3" width="18" height="18" rx="2" />);
const IconFlex = () =>
	I(
		<>
			<rect x="3" y="3" width="7" height="18" rx="1" />
			<rect x="14" y="3" width="7" height="18" rx="1" />
		</>
	);
const IconGrid = () =>
	I(
		<>
			<rect x="3" y="3" width="7" height="7" />
			<rect x="14" y="3" width="7" height="7" />
			<rect x="3" y="14" width="7" height="7" />
			<rect x="14" y="14" width="7" height="7" />
		</>
	);
const IconArrowRight = () =>
	I(
		<>
			<line x1="5" y1="12" x2="19" y2="12" />
			<polyline points="12 5 19 12 12 19" />
		</>
	);
const IconArrowDown = () =>
	I(
		<>
			<line x1="12" y1="5" x2="12" y2="19" />
			<polyline points="5 12 12 19 19 12" />
		</>
	);
const IconLayout = () =>
	I(
		<>
			<rect x="3" y="3" width="18" height="18" rx="2" />
			<line x1="3" y1="9" x2="21" y2="9" />
			<line x1="9" y1="9" x2="9" y2="21" />
		</>
	);
const IconType = () =>
	I(
		<>
			<polyline points="4 7 4 4 20 4 20 7" />
			<line x1="9" y1="20" x2="15" y2="20" />
			<line x1="12" y1="4" x2="12" y2="20" />
		</>
	);
const IconCode = () =>
	I(
		<>
			<polyline points="16 18 22 12 16 6" />
			<polyline points="8 6 2 12 8 18" />
		</>
	);
const IconLink = () =>
	I(
		<>
			<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
			<path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
		</>
	);
const IconUnlink = () =>
	I(
		<>
			<path d="M18.84 12.25l1.72-1.71a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
			<path d="M5.17 11.75l-1.72 1.71a5 5 0 0 0 7.07 7.07l1.71-1.71" />
			<line x1="8" y1="2" x2="8" y2="5" />
			<line x1="2" y1="8" x2="5" y2="8" />
			<line x1="16" y1="19" x2="16" y2="22" />
			<line x1="19" y1="16" x2="22" y2="16" />
		</>
	);
const IconAxis = () =>
	I(
		<>
			<line x1="12" y1="4" x2="12" y2="20" />
			<polyline points="9 6 12 3 15 6" />
			<polyline points="9 18 12 21 15 18" />
			<line x1="4" y1="12" x2="20" y2="12" />
			<polyline points="6 9 3 12 6 15" />
			<polyline points="18 9 21 12 18 15" />
		</>
	);
const IconContained = () =>
	I(
		<>
			<line x1="3" y1="4" x2="3" y2="20" />
			<line x1="21" y1="4" x2="21" y2="20" />
			<rect x="8" y="7" width="8" height="10" rx="1" />
		</>
	);
const IconFull = () => I(<rect x="3" y="7" width="18" height="10" rx="1" />);

/* ------------------------------------------------------------ control kit */
/* GB-style building blocks: collapsible Section (session-remembered),
   icon segmented control, token select, textarea. Every future control
   builds from these. */

const sectionMemory = new Map(); // session-only open/closed state

function Section({ id, icon, label, defaultOpen = true, children }) {
	const [open, setOpen] = useState(() => (sectionMemory.has(id) ? sectionMemory.get(id) : defaultOpen));
	const toggle = () => {
		sectionMemory.set(id, !open);
		setOpen(!open);
	};
	return (
		<div className={"mb-section" + (open ? " is-open" : "")} data-testid={"section-" + id}>
			<button type="button" className="mb-section-header" data-testid={"section-toggle-" + id} onClick={toggle} aria-expanded={open}>
				<span className="mb-section-icon">{icon}</span>
				<span className="mb-section-label">{label}</span>
				<span className={"mb-section-chevron" + (open ? " is-open" : "")} aria-hidden="true">
					{I(<polyline points="6 9 12 15 18 9" />)}
				</span>
			</button>
			{open && <div className="mb-section-body">{children}</div>}
		</div>
	);
}

function Field({ label, children }) {
	return (
		<label className="mb-field">
			<span className="mb-field-label">{label}</span>
			{children}
		</label>
	);
}

function SegmentedControl({ label, name, value, options, onChange }) {
	return (
		<div className="mb-field">
			<span className="mb-field-label">{label}</span>
			<div className="mb-segmented" role="group" aria-label={label} data-name={name}>
				{options.map((opt) => (
					<button
						key={opt.value}
						type="button"
						title={opt.title}
						aria-pressed={value === opt.value}
						className={value === opt.value ? "is-active" : ""}
						data-testid={`seg-${name}-${opt.value}`}
						onClick={() => onChange(opt.value)}
					>
						{opt.icon}
						{opt.text && <span className="mb-seg-text">{opt.text}</span>}
					</button>
				))}
			</div>
		</div>
	);
}

function TokenSelect({ label, name, value, options, onChange }) {
	return (
		<Field label={label}>
			<select name={name} value={value} onChange={(e) => onChange(e.target.value)}>
				{options.map(([v, text]) => (
					<option key={v} value={v}>
						{text}
					</option>
				))}
			</select>
		</Field>
	);
}

/* --------------------------------------------------------- SpacingControl */
/* GB-style four-side control with three link modes. The stored shape is
   always {top,right,bottom,left} strings; the mode is pure UI. Values
   accept number+unit or raw CSS (var/calc/clamp) verbatim. */

const SPACE_TOKENS = ["xs", "s", "m", "l", "xl"];
const UNIT_RE = /^(-?[\d.]+)(px|rem|em|%)$/;

function deriveSpacingMode(v) {
	const t = v.top || "", r = v.right || "", b = v.bottom || "", l = v.left || "";
	if (t === r && r === b && b === l) return "linked";
	if (t === b && l === r) return "axis";
	return "individual";
}

function SpacingField({ side, sideLabel, value, onChange, onCommit }) {
	const m = UNIT_RE.exec(value || "");
	const display = m ? m[1] : value || "";
	const unit = m ? m[2] : "";
	return (
		<div className="mb-spacing-field">
			<span className="mb-spacing-side">{sideLabel}</span>
			<input
				type="text"
				value={display}
				data-side={side}
				onChange={(e) => {
					// Never trim mid-typing — calc()/var() need their spaces.
					const t = e.target.value;
					if (t.trim() === "") onChange("");
					else if (/^-?[\d.]+$/.test(t.trim())) onChange(t.trim() + (unit || "px"));
					else onChange(t);
				}}
				onBlur={onCommit}
			/>
			<select
				className="mb-spacing-unit"
				data-side-unit={side}
				value={unit}
				disabled={!m && (value || "") !== ""}
				onChange={(e) => {
					if (m) onChange(m[1] + e.target.value);
				}}
			>
				<option value="" disabled hidden>
					–
				</option>
				{["px", "rem", "em", "%"].map((u) => (
					<option key={u} value={u}>
						{u}
					</option>
				))}
			</select>
		</div>
	);
}

function SpacingControl({ label, value, onChange, onCommit }) {
	const [mode, setMode] = useState(() => deriveSpacingMode(value));

	const setSides = (sides, v, coalesce) => {
		const next = { ...value };
		sides.forEach((s) => (next[s] = v));
		onChange(next, coalesce);
	};

	const cycle = () => {
		if (mode === "linked") {
			// pairs are already equal coming from linked; no value change
			setMode("axis");
		} else if (mode === "axis") {
			setMode("individual");
		} else {
			// individual -> linked: top (or the common value) drives all four
			const v = value.top || "";
			if (value.right !== v || value.bottom !== v || value.left !== v) {
				onChange({ top: v, right: v, bottom: v, left: v }, null);
			}
			setMode("linked");
		}
	};

	const modeMeta = {
		linked: { icon: <IconLink />, title: "Linked — one value, all sides" },
		axis: { icon: <IconAxis />, title: "Axis — Y (top/bottom) and X (left/right)" },
		individual: { icon: <IconUnlink />, title: "Individual sides" },
	};

	return (
		<div className="mb-field mb-spacing" data-testid="spacing-control" data-mode={mode}>
			<span className="mb-field-label mb-spacing-head">
				{label}
				<button type="button" className="mb-spacing-mode" data-testid="spacing-mode" title={modeMeta[mode].title} onClick={cycle}>
					{modeMeta[mode].icon}
				</button>
			</span>

			<div className="mb-spacing-fields">
				{mode === "linked" && (
					<SpacingField side="all" sideLabel="All" value={value.top || ""} onChange={(v) => setSides(["top", "right", "bottom", "left"], v, "padding:all")} onCommit={onCommit} />
				)}
				{mode === "axis" && (
					<>
						<SpacingField side="y" sideLabel="Y" value={value.top || ""} onChange={(v) => setSides(["top", "bottom"], v, "padding:y")} onCommit={onCommit} />
						<SpacingField side="x" sideLabel="X" value={value.left || ""} onChange={(v) => setSides(["left", "right"], v, "padding:x")} onCommit={onCommit} />
					</>
				)}
				{mode === "individual" &&
					[
						["top", "T"],
						["right", "R"],
						["bottom", "B"],
						["left", "L"],
					].map(([side, sideLabel]) => (
						<SpacingField key={side} side={side} sideLabel={sideLabel} value={value[side] || ""} onChange={(v) => setSides([side], v, "padding:" + side)} onCommit={onCommit} />
					))}
			</div>

			<div className="mb-spacing-presets" role="group" aria-label="Spacing tokens">
				{SPACE_TOKENS.map((tok) => (
					<button
						key={tok}
						type="button"
						data-testid={"pad-token-" + tok}
						title={`var(--space-${tok})`}
						onClick={() => {
							const v = `var(--space-${tok})`;
							onChange({ top: v, right: v, bottom: v, left: v }, null);
							setMode("linked");
						}}
					>
						{tok}
					</button>
				))}
				<button
					type="button"
					data-testid="pad-token-clear"
					title="Clear padding"
					onClick={() => {
						onChange({ top: "", right: "", bottom: "", left: "" }, null);
						setMode("linked");
					}}
				>
					×
				</button>
			</div>
		</div>
	);
}

/* Sections registered per widget type; future widgets slot in here. */

function ContainerLayoutSection({ node, isRoot, set, dispatch }) {
	const layout = node.props.layout === "div" || node.props.layout === "grid" ? node.props.layout : "flex";
	const GAP_OPTIONS = [
		["none", "None"],
		["sm", "Small"],
		["md", "Medium"],
		["lg", "Large"],
	];
	return (
		<>
			{!isRoot && (
				<SegmentedControl
					label="Type"
					name="layout"
					value={layout}
					onChange={(v) => set({ layout: v })}
					options={[
						{ value: "div", icon: <IconBox />, title: "Div — plain block box" },
						{ value: "flex", icon: <IconFlex />, title: "Flexbox" },
						{ value: "grid", icon: <IconGrid />, title: "Grid" },
					]}
				/>
			)}
			{layout === "flex" && (
				<SegmentedControl
					label="Direction"
					name="direction"
					value={node.props.direction}
					onChange={(v) => set({ direction: v })}
					options={[
						{ value: "column", icon: <IconArrowDown />, title: "Column" },
						{ value: "row", icon: <IconArrowRight />, title: "Row" },
					]}
				/>
			)}
			{(layout === "flex" || layout === "grid") && (
				<TokenSelect label="Gap" name="gap" value={node.props.gap} options={GAP_OPTIONS} onChange={(v) => set({ gap: v })} />
			)}
			{!isRoot && (
				<SegmentedControl
					label="Width"
					name="width"
					value={node.props.width}
					onChange={(v) => set({ width: v })}
					options={[
						{ value: "full", icon: <IconFull />, title: "Full width" },
						{ value: "contained", icon: <IconContained />, title: "Contained" },
					]}
				/>
			)}
			<ContainerPadding node={node} dispatch={dispatch} />
		</>
	);
}

/* Legacy stepped padding (sm/md/lg classes) displays as its token
   equivalent; the first edit converts the node to generated styles and
   clears the legacy prop in the same history step. */
const LEGACY_PAD_TOKEN = { sm: "var(--space-s)", md: "var(--space-m)", lg: "var(--space-xl)" };

function ContainerPadding({ node, dispatch }) {
	const stored = node.styles && node.styles.padding;
	const legacy = !stored ? LEGACY_PAD_TOKEN[node.props.padding] : null;
	const value = {
		top: (stored && stored.top) || legacy || "",
		right: (stored && stored.right) || legacy || "",
		bottom: (stored && stored.bottom) || legacy || "",
		left: (stored && stored.left) || legacy || "",
	};

	const onChange = (next, coalesce) =>
		dispatch({
			type: "styles",
			id: node.id,
			patch: { padding: next },
			alsoProps: node.props.padding && node.props.padding !== "none" ? { padding: "none" } : undefined,
			coalesce,
		});

	return <SpacingControl key={node.id} label="Padding" value={value} onChange={onChange} onCommit={() => dispatch({ type: "commit" })} />;
}

function TextContentSection({ node, set, dispatch }) {
	return (
		<>
			<TokenSelect label="Tag" name="tag" value={node.props.tag} options={["h1", "h2", "h3", "h4", "h5", "h6", "p"].map((t) => [t, t])} onChange={(v) => set({ tag: v })} />
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
	);
}

const WIDGET_SECTIONS = {
	container: [{ id: "layout", label: "Layout", icon: <IconLayout />, render: ContainerLayoutSection }],
	text: [{ id: "content", label: "Content", icon: <IconType />, render: TextContentSection }],
};

function BlockTab({ node, isRoot, dispatch }) {
	if (!node) {
		return (
			<div className="mb-empty-state" data-testid="empty-state">
				<p>Select a block on the canvas to edit its settings, or drag a widget in from the left.</p>
			</div>
		);
	}

	const set = (patch) => dispatch({ type: "props", id: node.id, patch });
	const sections = WIDGET_SECTIONS[node.type] || [];

	return (
		<div className="mb-inspector" data-testid="inspector">
			<h2 className="mb-panel-heading mb-inspector-title">
				{nodeLabel(node)}
				{isRoot ? " (page root)" : ""}
			</h2>

			{sections.map((s) => (
				<Section key={s.id} id={s.id} icon={s.icon} label={s.label}>
					<s.render node={node} isRoot={isRoot} set={set} dispatch={dispatch} />
				</Section>
			))}

			<Section id="css" icon={<IconCode />} label="Custom CSS" defaultOpen={false}>
				<textarea
					name="css"
					rows={5}
					placeholder={"selector {\n\t\n}"}
					value={node.css}
					onChange={(e) => dispatch({ type: "css", id: node.id, css: e.target.value })}
					onBlur={() => dispatch({ type: "commit" })}
				/>
				<p className="mb-hint">“selector” targets this block (.m-{node.id}). Empty = nothing shipped.</p>
			</Section>

			{!isRoot && (
				<div className="mb-inspector-footer">
					<button type="button" className="mb-btn mb-btn-danger" data-testid="delete-node" onClick={() => dispatch({ type: "delete", id: node.id })}>
						Delete block
					</button>
				</div>
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
