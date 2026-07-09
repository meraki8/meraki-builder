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

rsync -a \
	--exclude '.git' \
	--exclude '.github' \
	--exclude '.gitignore' \
	--exclude 'build' \
	--exclude 'node_modules' \
	--exclude 'src' \
	--exclude 'scripts' \
	--exclude 'package.json' \
	--exclude 'package-lock.json' \
	--exclude 'CHANGELOG.md' \
	--exclude 'README.md' \
	--exclude '.DS_Store' \
	./ build/meraki-builder/

(cd build && zip -rq meraki-builder.zip meraki-builder)

echo "Built build/meraki-builder.zip ($(zipinfo -1 build/meraki-builder.zip | grep -c .) entries)"
