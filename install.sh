#!/usr/bin/env bash
# Installs the Tray Collapse Cinnamon applet for the current user and adds it to the panel
# next to the system tray. Usage: ./install.sh          install / update
#                                 ./install.sh --remove remove from panel and delete
# Also works piped: curl -fsSL <raw install.sh url> | bash  (append "-s -- --remove" to remove)
set -euo pipefail

UUID="tray-collapse@fabri"
REPO="nagasab221/tray-collapse"

# Piped through curl there are no applet files next to us: fetch the repo and rerun from it.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-.}")" && pwd)"
if [[ ! -d "$SCRIPT_DIR/applet/$UUID" ]]; then
    TMP="$(mktemp -d)"
    trap 'rm -rf "$TMP"' EXIT
    echo "Downloading Tray Collapse from github.com/$REPO ..."
    curl -fsSL "https://github.com/$REPO/archive/refs/heads/main.tar.gz" | tar xz -C "$TMP" --strip-components=1
    bash "$TMP/install.sh" "$@"
    exit $?
fi
SRC="$SCRIPT_DIR/applet/$UUID"
DEST="$HOME/.local/share/cinnamon/applets/$UUID"

if [[ "${XDG_CURRENT_DESKTOP:-}" != *Cinnamon* ]]; then
    echo "This applet needs the Cinnamon desktop (current: ${XDG_CURRENT_DESKTOP:-unknown})." >&2
    exit 1
fi

# Prints the new enabled-applets list, or nothing if no change is needed.
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
    sys.exit()  # already on a panel

# Sit just left of the tray on the panel/zone that holds it; else right side of panel1.
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
    echo "Tray Collapse removed."
    exit 0
fi

[[ -d "$SRC" ]] || { echo "Applet files not found at $SRC" >&2; exit 1; }

mkdir -p "$(dirname "$DEST")"
rm -rf "$DEST"
cp -r "$SRC" "$DEST"

new="$(edit_applets add)"
if [[ -n "$new" ]]; then
    gsettings set org.cinnamon enabled-applets "$new"
    echo "Tray Collapse installed and added to your panel."
else
    # Already on the panel: reload it so updated files take effect.
    gdbus call --session --dest org.Cinnamon --object-path /org/Cinnamon \
        --method org.Cinnamon.ReloadXlet "$UUID" APPLET >/dev/null 2>&1 || true
    echo "Tray Collapse updated."
fi
