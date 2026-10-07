#!/usr/bin/env bash
# installs tray-collapse and puts it on the panel next to the tray
#   ./install.sh            install or update
#   ./install.sh --remove   uninstall
set -euo pipefail

UUID="tray-collapse@fabri"
REPO="nagasab221/tray-collapse"

# when run through curl the applet files aren't here, so grab the repo first
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-.}")" && pwd)"
if [[ ! -d "$SCRIPT_DIR/applet/$UUID" ]]; then
    TMP="$(mktemp -d)"
    trap 'rm -rf "$TMP"' EXIT
    echo "downloading tray-collapse..."
    curl -fsSL "https://github.com/$REPO/archive/refs/heads/main.tar.gz" | tar xz -C "$TMP" --strip-components=1
    bash "$TMP/install.sh" "$@"
    exit $?
fi
SRC="$SCRIPT_DIR/applet/$UUID"
DEST="$HOME/.local/share/cinnamon/applets/$UUID"

if [[ "${XDG_CURRENT_DESKTOP:-}" != *Cinnamon* ]]; then
    echo "this only works on cinnamon (you're on ${XDG_CURRENT_DESKTOP:-unknown})" >&2
    exit 1
fi

# prints the new applet list, or nothing if there's nothing to change
edit_applets() {
    gsettings get org.cinnamon enabled-applets | python3 -c '
import ast, sys
mode, uuid = sys.argv[1], sys.argv[2]
raw = sys.stdin.read().strip()
entries = [] if raw.startswith("@as") else ast.literal_eval(raw)
mine = [e for e in entries if e.split(":")[3] == uuid]

if mode == "remove":
    if mine:
        print([e for e in entries if e not in mine])
    sys.exit()

if mine:
    sys.exit()  # already there

# go just left of the tray if we can find it
tray = [e.split(":") for e in entries
        if e.split(":")[3] in ("xapp-status@cinnamon.org", "systray@cinnamon.org")]
if tray:
    panel, zone = tray[0][0], tray[0][1]
    order = max(0, min(int(t[2]) for t in tray if t[:2] == [panel, zone]) - 1)
else:
    panel, zone, order = "panel1", "right", 0
next_id = max([int(e.split(":")[4]) for e in entries] + [0]) + 1
entries.append(f"{panel}:{zone}:{order}:{uuid}:{next_id}")
print(entries)
' "$1" "$UUID"
}

if [[ "${1:-}" == "--remove" ]]; then
    new="$(edit_applets remove)"
    [[ -n "$new" ]] && gsettings set org.cinnamon enabled-applets "$new"
    sleep 1
    rm -rf "$DEST"
    echo "removed"
    exit 0
fi

[[ -d "$SRC" ]] || { echo "can't find the applet files in $SRC" >&2; exit 1; }

mkdir -p "$(dirname "$DEST")"
rm -rf "$DEST"
cp -r "$SRC" "$DEST"

new="$(edit_applets add)"
if [[ -n "$new" ]]; then
    gsettings set org.cinnamon enabled-applets "$new"
    echo "installed, check your panel"
else
    # already on the panel, just reload it
    gdbus call --session --dest org.Cinnamon --object-path /org/Cinnamon \
        --method org.Cinnamon.ReloadXlet "$UUID" APPLET >/dev/null 2>&1 || true
    echo "updated"
fi
