#!/bin/sh
# Installs `alfred-approve` outside any memory, writable only by an administrator (SPEC §14), and the owner's anchor.
# Run once, by the owner:   sudo sh scripts/install-approve.sh
# Testing without root:     PREFIX=/tmp/x ANCHOR_DIR=/tmp/x/etc OWNER_PUB=/path/key.pub NO_CHOWN=1 sh scripts/install-approve.sh
set -eu
HERE="$(cd "$(dirname "$0")/.." && pwd)"
PREFIX="${PREFIX:-/usr/local}"
ANCHOR_DIR="${ANCHOR_DIR:-/etc/alfredish}"
KEY_NAME="${KEY_NAME:-alfred-owner}"
LIB="$PREFIX/lib/alfredish"
OWNER="${SUDO_USER:-$(id -un)}"
OWNER_HOME="$(eval echo "~$OWNER")"
SOCKET="${SOCKET:-$OWNER_HOME/Library/Containers/com.maxgoedjen.Secretive.SecretAgent/Data/socket.ssh}"

# 1. The owner's public key: given, or read from the key store's agent (only the public half is ever read).
if [ -n "${OWNER_PUB:-}" ]; then
  KEY="$(cat "$OWNER_PUB")"
else
  KEY="$(SSH_AUTH_SOCK="$SOCKET" ssh-add -L | grep -i "$KEY_NAME" | head -1 || true)"
fi
[ -n "$KEY" ] || { echo "no public key named $KEY_NAME in the agent at $SOCKET"; exit 1; }

# 2. A copy of Alfredish (code, its node_modules, no models: approving needs no embedding model).
rm -rf "$LIB"
mkdir -p "$LIB" "$PREFIX/bin" "$ANCHOR_DIR"
cp -R "$HERE/src" "$HERE/package.json" "$HERE/node_modules" "$LIB/"
# Node itself is copied too: the system's node may live in a folder the owner (and so an agent) can write.
cp "$(command -v node)" "$LIB/node"
git -C "$HERE" rev-parse --short HEAD > "$LIB/PINNED" 2>/dev/null || true
# Where it came from: a new vendor/alfredish copy in a memory is compared with this source before the owner approves it.
echo "$HERE" > "$LIB/SOURCE"

# 3. The anchor: the list of the owner's public keys.
printf '# the owner of the memories on this machine (alfredish §14)\n%s\n' "$KEY" > "$ANCHOR_DIR/owner.pub"

# 4. The command. It always runs this copy, never the memory's vendor/alfredish.
cat > "$PREFIX/bin/alfred-approve" <<WRAP
#!/bin/sh
# alfred-approve: the owner's approval round for the memory in the current folder (alfredish §14).
PATH=/usr/bin:/bin ALFREDISH_ANCHOR="$ANCHOR_DIR/owner.pub" exec "$LIB/node" "$LIB/src/cli.ts" approve --agent "\${ALFREDISH_AGENT_SOCKET:-$SOCKET}" "\$@"
WRAP
chmod 755 "$PREFIX/bin/alfred-approve"

# 5. Only an administrator may change any of it.
if [ -z "${NO_CHOWN:-}" ]; then
  chown -R root:wheel "$LIB" "$ANCHOR_DIR" "$PREFIX/bin/alfred-approve"
  chmod -R go-w "$LIB" "$ANCHOR_DIR" "$PREFIX/bin/alfred-approve"
fi
echo "installed: $PREFIX/bin/alfred-approve (Alfredish $(cat "$LIB/PINNED" 2>/dev/null || echo '?'))"
echo "anchor:    $ANCHOR_DIR/owner.pub"
echo "key:       $(echo "$KEY" | cut -c1-40)…"
