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
 * Compile per-node generated styles (styles.padding for now) to CSS.
 * Mirrors the server-side compiler; the canvas injects the result live.
 */
export function compileStyles(node, prefix = "", out = []) {
	const pad = node.styles && node.styles.padding;
	if (pad) {
		const rules = ["top", "right", "bottom", "left"]
			.filter((s) => (pad[s] || "").trim() !== "")
			.map((s) => `padding-${s}:${pad[s].trim()}`);
		if (rules.length) out.push(`${prefix}.m-${node.id}{${rules.join(";")}}`);
	}
	node.children.forEach((c) => compileStyles(c, prefix, out));
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
