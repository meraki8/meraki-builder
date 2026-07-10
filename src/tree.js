// Immutable tree operations. Every mutation returns a new root;
// untouched branches keep their references (undo/redo later can
// snapshot roots cheaply).

export const WIDGETS = {
	container: {
		label: "Container",
		// GenerateBlocks-style: the outer container is a full-width section
		// band; content wrapping comes from nesting a contained container.
		defaults: { layout: "flex", direction: "column", gap: "md", width: "full", padding: "none" },
	},
	text: {
		label: "Text",
		defaults: { tag: "p", content: "Add your text" },
	},
};

export const newId = () => {
	let id = "";
	while (id.length < 6) id += Math.random().toString(36).slice(2);
	return id.slice(0, 6);
};

export const createNode = (type) => ({
	id: newId(),
	type,
	props: { ...WIDGETS[type].defaults },
	css: "",
	styles: {},
	children: [],
});

/**
 * THE breakpoint constant (mirrored in PHP: meraki_builder_breakpoints()).
 * Desktop-first: base has no media query; smaller views override inside
 * max-width queries, emitted in descending width order.
 */
export const BREAKPOINTS = [
	{ key: "base", label: "Desktop", maxWidth: null, canvas: null },
	{ key: "tabletL", label: "Tablet Landscape", maxWidth: 1024, canvas: 1024 },
	{ key: "tabletP", label: "Tablet Portrait", maxWidth: 768, canvas: 768 },
	{ key: "mobile", label: "Mobile", maxWidth: 480, canvas: 390 },
];
export const BP_KEYS = BREAKPOINTS.map((b) => b.key);

const PAD_SIDES = ["top", "right", "bottom", "left"];

/**
 * Pre-0.4.0 nodes store flat styles.padding; read it as base.padding.
 * Pure — used at read time everywhere, materialized on first edit.
 */
export function normalizeStyles(styles) {
	if (!styles) return {};
	if (!styles.padding) return styles;
	const { padding, ...rest } = styles;
	return {
		...rest,
		base: { ...(rest.base || {}), padding: { ...((rest.base || {}).padding || {}), ...padding } },
	};
}

/** Local (stored) value of styles[bucket][key][prop], or "". */
export function localStyle(node, bucket, key, prop) {
	const s = normalizeStyles(node.styles);
	return (((s[bucket] || {})[key] || {})[prop] || "").trim();
}

/**
 * Effective value at a breakpoint: nearest larger breakpoint (or the
 * breakpoint itself) that sets the property; `legacy` supplies the
 * stepped-prop token as the base-level fallback.
 */
export function effectiveStyle(node, bucket, key, prop, legacy = "") {
	const s = normalizeStyles(node.styles);
	let value = legacy;
	for (const bp of BP_KEYS) {
		const v = (((s[bp] || {})[key] || {})[prop] || "").trim();
		if (v !== "") value = v;
		if (bp === bucket) break;
	}
	return value;
}

/** Does this bucket hold any non-empty style value on the node? */
export function bucketHasStyles(node, bucket) {
	const b = normalizeStyles(node.styles)[bucket];
	if (!b) return false;
	return Object.values(b).some((group) => group && Object.values(group).some((v) => (v || "").trim() !== ""));
}

function bucketDeclarations(bucket) {
	const decl = [];
	const pad = bucket.padding;
	if (pad) {
		PAD_SIDES.forEach((s) => {
			if ((pad[s] || "").trim() !== "") decl.push(`padding-${s}:${pad[s].trim()}`);
		});
	}
	const gap = bucket.gap;
	if (gap) {
		const row = (gap.row || "").trim();
		const col = (gap.column || "").trim();
		if (row !== "" && row === col) decl.push(`gap:${row}`);
		else {
			if (row !== "") decl.push(`row-gap:${row}`);
			if (col !== "") decl.push(`column-gap:${col}`);
		}
	}
	return decl;
}

/**
 * Front-end-shaped compile (base rule + descending max-width queries).
 * Mirrors the server compiler; used for verification and reference.
 */
export function compileStyles(node, prefix = "", out = []) {
	const s = normalizeStyles(node.styles);
	for (const bp of BREAKPOINTS) {
		const decl = s[bp.key] ? bucketDeclarations(s[bp.key]) : [];
		if (decl.length) {
			const rule = `${prefix}.m-${node.id}{${decl.join(";")}}`;
			out.push(bp.maxWidth ? `@media (max-width:${bp.maxWidth}px){${rule}}` : rule);
		}
	}
	node.children.forEach((c) => compileStyles(c, prefix, out));
	return out;
}

/**
 * Canvas compile: the canvas resizes rather than being a real viewport,
 * so media queries can't fire — emit each node's EFFECTIVE styles for
 * the previewed breakpoint directly.
 */
export function compileCanvasStyles(node, deviceKey, out = []) {
	const s = normalizeStyles(node.styles);
	const idx = BP_KEYS.indexOf(deviceKey);
	const merged = {};
	for (let i = 0; i <= idx; i++) {
		const b = s[BP_KEYS[i]];
		if (!b) continue;
		for (const key of Object.keys(b)) {
			merged[key] = merged[key] || {};
			for (const prop of Object.keys(b[key])) {
				if ((b[key][prop] || "").trim() !== "") merged[key][prop] = b[key][prop];
			}
		}
	}
	const decl = bucketDeclarations(merged);
	if (decl.length) out.push(`.mb-canvas .m-${node.id}{${decl.join(";")}}`);
	node.children.forEach((c) => compileCanvasStyles(c, deviceKey, out));
	return out;
}

export function findNode(node, id) {
	if (node.id === id) return node;
	for (const child of node.children) {
		const found = findNode(child, id);
		if (found) return found;
	}
	return null;
}

export function findParent(node, id) {
	for (const child of node.children) {
		if (child.id === id) return node;
		const found = findParent(child, id);
		if (found) return found;
	}
	return null;
}

export function updateNode(root, id, fn) {
	if (root.id === id) return fn(root);
	let changed = false;
	const children = root.children.map((child) => {
		const next = updateNode(child, id, fn);
		if (next !== child) changed = true;
		return next;
	});
	return changed ? { ...root, children } : root;
}

export function insertNode(root, parentId, index, node) {
	return updateNode(root, parentId, (parent) => ({
		...parent,
		children: [...parent.children.slice(0, index), node, ...parent.children.slice(index)],
	}));
}

export function removeNode(root, id) {
	let removed = null;
	const walk = (node) => {
		const kept = [];
		let changed = false;
		for (const child of node.children) {
			if (child.id === id) {
				removed = child;
				changed = true;
				continue;
			}
			const next = walk(child);
			if (next !== child) changed = true;
			kept.push(next);
		}
		return changed ? { ...node, children: kept } : node;
	};
	const next = walk(root);
	return { root: next, removed };
}

export function moveNode(root, id, parentId, index) {
	if (id === parentId) return root;
	const node = findNode(root, id);
	if (!node || findNode(node, parentId)) return root; // can't move into own subtree

	const oldParent = findParent(root, id);
	if (oldParent && oldParent.id === parentId) {
		const oldIndex = oldParent.children.findIndex((c) => c.id === id);
		if (oldIndex < index) index -= 1;
	}

	const { root: without, removed } = removeNode(root, id);
	if (!removed) return root;
	return insertNode(without, parentId, index, removed);
}

export function moveNodeWrapped(root, id, parentId, index, wrapper) {
	if (id === parentId) return root;
	const node = findNode(root, id);
	if (!node || findNode(node, parentId)) return root;

	const oldParent = findParent(root, id);
	if (oldParent && oldParent.id === parentId) {
		const oldIndex = oldParent.children.findIndex((c) => c.id === id);
		if (oldIndex < index) index -= 1;
	}

	const { root: without, removed } = removeNode(root, id);
	if (!removed) return root;
	return insertNode(without, parentId, index, { ...wrapper, children: [removed] });
}

export function depthOf(root, id, depth = 0) {
	if (root.id === id) return depth;
	for (const child of root.children) {
		const d = depthOf(child, id, depth + 1);
		if (d !== -1) return d;
	}
	return -1;
}

export function subtreeHeight(node) {
	if (!node.children.length) return 1;
	return 1 + Math.max(...node.children.map(subtreeHeight));
}
