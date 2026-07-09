#!/usr/bin/env bash
# Build meraki-builder.zip with the plugin in a top-level folder named
# exactly "meraki-builder". WordPress uses the folder name as the plugin
# identity — it must be stable across releases and never versioned.
# Run `npm run build` first; the editor bundle must exist.
set -euo pipefail

cd "$(dirname "$0")/.."

if [ ! -f editor/build/editor.js ]; then
	echo "editor/build/editor.js missing — run: npm run build" >&2
	exit 1
fi

rm -rf build
mkdir -p build/meraki-builder

# Excludes are anchored to the repo root — a bare 'build' would also
# strip editor/build/, which is the compiled editor bundle.
rsync -a \
	--exclude '/.git' \
	--exclude '/.github' \
	--exclude '/.gitignore' \
	--exclude '/build' \
	--exclude '/node_modules' \
	--exclude '/src' \
	--exclude '/scripts' \
	--exclude '/package.json' \
	--exclude '/package-lock.json' \
	--exclude '/CHANGELOG.md' \
	--exclude '/README.md' \
	--exclude '.DS_Store' \
	./ build/meraki-builder/

if [ ! -f build/meraki-builder/editor/build/editor.js ]; then
	echo "staged zip is missing the editor bundle" >&2
	exit 1
fi

(cd build && zip -rq meraki-builder.zip meraki-builder)

echo "Built build/meraki-builder.zip ($(zipinfo -1 build/meraki-builder.zip | grep -c .) entries)"
