#!/bin/sh
# Installs `alfred-approve` outside any memory, writable only by an administrator (SPEC §14), and the owner's anchor.
# First install, by the owner:   sudo sh scripts/install-approve.sh
# Update (run by alfred-approve itself when a memory uses another Alfredish):
#                                 sudo /bin/sh /usr/local/lib/alfredish/install-approve.sh --update <commit>
#   It runs this root-owned copy of the installer, never the one in the Alfredish folder (which an agent can edit),
#   takes only that commit's code from the Alfredish source, and leaves the anchor, node and the command untouched.
# Testing without root:          PREFIX=/tmp/x ANCHOR_DIR=/tmp/x/etc OWNER_PUB=/path/key.pub NO_CHOWN=1 sh scripts/install-approve.sh
set -eu
PREFIX="${PREFIX:-/usr/local}"
ANCHOR_DIR="${ANCHOR_DIR:-/etc/alfredish}"
KEY_NAME="${KEY_NAME:-alfred-owner}"
LIB="$PREFIX/lib/alfredish"
OWNER="${SUDO_USER:-$(id -un)}"
OWNER_HOME="$(eval echo "~$OWNER")"
SOCKET="${SOCKET:-$OWNER_HOME/Library/Containers/com.maxgoedjen.Secretive.SecretAgent/Data/socket.ssh}"
lock() {
  if [ -z "${NO_CHOWN:-}" ]; then
    chown -R root:wheel "$@"
    chmod -R go-w "$@"
  fi
}
# The source is read as its owner, never as root (git refuses other users' repositories, and root needs no more).
as_owner() { if [ "$(id -un)" = "$OWNER" ]; then "$@"; else sudo -u "$OWNER" "$@"; fi; }

if [ "${1:-}" = "--update" ]; then
  COMMIT="${2:-}"
  printf '%s' "$COMMIT" | grep -Eq '^[0-9a-f]{7,40}$' || { echo "update: not a commit id: $COMMIT"; exit 1; }
  { [ -f "$LIB/SOURCE" ] && [ -x "$LIB/node" ]; } || { echo "update: no installed alfred-approve to update — run the first install"; exit 1; }
  HERE="$(cat "$LIB/SOURCE")"
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT
  as_owner git -C "$HERE" archive "$COMMIT" -- src package.json > "$TMP/code.tar" || { echo "update: Alfredish $COMMIT not found in $HERE"; exit 1; }
  mkdir "$TMP/code"
  tar -xf "$TMP/code.tar" -C "$TMP/code"
  # Replace the code; keep the installer, the source, node, the anchor and the command as they are.
  rm -rf "$LIB/src" "$LIB/package.json" "$LIB/node_modules"
  cp -R "$TMP/code/src" "$TMP/code/package.json" "$LIB/"
  cp -R "$HERE/node_modules" "$LIB/"
  printf '%s\n' "$COMMIT" > "$LIB/PINNED"
  lock "$LIB"
  echo "updated: alfred-approve is now Alfredish $COMMIT"
  exit 0
fi

HERE="$(cd "$(dirname "$0")/.." && pwd)"
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
# Where it came from: updates take their code from here, and a memory's vendor/alfredish copy is compared with it.
echo "$HERE" > "$LIB/SOURCE"
# The installer itself, so updates run this root-owned copy, never the editable one in the Alfredish folder.
cp "$HERE/scripts/install-approve.sh" "$LIB/install-approve.sh"

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
lock "$LIB" "$ANCHOR_DIR" "$PREFIX/bin/alfred-approve"
echo "installed: $PREFIX/bin/alfred-approve (Alfredish $(cat "$LIB/PINNED" 2>/dev/null || echo '?'))"
echo "anchor:    $ANCHOR_DIR/owner.pub"
echo "key:       $(echo "$KEY" | cut -c1-40)…"
