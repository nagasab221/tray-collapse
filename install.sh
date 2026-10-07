#!/usr/bin/env bash
# installs tray-collapse and puts it on the panel next to the tray
#   ./install.sh            install or update
#   ./install.sh --remove   uninstall
set -euo pipefail

UUID="tray-collapse@fabri"
REPO="nagasab221/tray-collapse"

if [[ $EUID -eq 0 ]]; then
    echo "run this as your normal user, not with sudo (it installs just for you)" >&2
    exit 1
fi
if ! command -v cinnamon >/dev/null; then
    echo "cinnamon isn't installed on this machine, this needs the cinnamon desktop" >&2
    echo "(desktop here: ${XDG_CURRENT_DESKTOP:-none detected})" >&2
    exit 1
fi

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

# over ssh or from a text console none of the desktop's environment is set. if cinnamon is
# running for this user, talk to that session instead. if it isn't, write the settings
# straight to disk and the applet shows up at the next login
LIVE=""
CINNAMON_PID="$(pgrep -u "$(id -u)" -x cinnamon | head -n1 || true)"
if [[ -n "$CINNAMON_PID" ]]; then
    LIVE=1
    for var in DBUS_SESSION_BUS_ADDRESS DISPLAY XDG_CURRENT_DESKTOP; do
        val="$(tr '\0' '\n' < "/proc/$CINNAMON_PID/environ" | sed -n "s/^$var=//p" | head -n1)"
        [[ -n "$val" ]] && export "$var=$val"
    done
elif ! command -v dbus-run-session >/dev/null; then
    echo "cinnamon isn't running for ${USER:-$(id -un)}, log into the cinnamon desktop and run this again" >&2
    exit 1
fi

gs() {
    if [[ -n "$LIVE" ]]; then
        gsettings "$@"
    else
        # the temporary dbus chatters on stderr, keep only gsettings own errors
        dbus-run-session -- bash -c 'gsettings "$@" 2>&3' _ "$@" 3>&2 2>/dev/null
    fi
}

# prints the new applet list, or nothing if there's nothing to change
edit_applets() {
    gs get org.cinnamon enabled-applets | python3 -c '
import ast, sys
mode, uuid, counter = sys.argv[1], sys.argv[2], int(sys.argv[3])
raw = sys.stdin.read().strip()
entries = [] if raw.startswith("@as") else ast.literal_eval(raw)
# panel:zone:order:uuid:id. the untouched defaults have no id yet
parts = lambda e: (e.split(":") + ["", "", "", "", ""])[:5]
mine = [e for e in entries if parts(e)[3] == uuid]

if mode == "remove":
    if mine:
        print([e for e in entries if e not in mine])
    sys.exit()

if mine:
    sys.exit()  # already there

# go just left of the tray if we can find it, else the right side of a panel that exists
tray = [parts(e) for e in entries
        if parts(e)[3] in ("xapp-status@cinnamon.org", "systray@cinnamon.org")]
orders = [int(t[2]) for t in tray if t[:2] == tray[0][:2] and t[2].isdigit()] if tray else []
if tray:
    panel, zone = tray[0][0], tray[0][1]
    order = max(0, min(orders) - 1) if orders else 0
else:
    panels = sorted({parts(e)[0] for e in entries if parts(e)[0]}) or ["panel1"]
    panel, zone, order = ("panel1" if "panel1" in panels else panels[0]), "right", 0
# take the number from cinnamons own counter (next-applet-id), the same way it does when
# you add an applet, so nothing it adds later can get the same one
next_id = max([counter, 1] + [int(parts(e)[4]) + 1 for e in entries if parts(e)[4].isdigit()])
entries.append(f"{panel}:{zone}:{order}:{uuid}:{next_id}")
print(entries)
' "$1" "$UUID" "$(gs get org.cinnamon next-applet-id)"
}

# keep cinnamons counter past every id in use (older versions of this script picked an id
# without bumping it, so the next applet added through cinnamon could get the same one)
fix_counter() {
    local needed
    needed="$(gs get org.cinnamon enabled-applets | python3 -c "
import ast, sys
raw = sys.stdin.read().strip()
entries = [] if raw.startswith('@as') else ast.literal_eval(raw)
ids = [int(e.split(':')[4]) for e in entries if len(e.split(':')) > 4 and e.split(':')[4].isdigit()]
print(max(ids) + 1 if ids else 0)")"
    if (( needed > $(gs get org.cinnamon next-applet-id) )); then
        gs set org.cinnamon next-applet-id "$needed"
    fi
}

if [[ "${1:-}" == "--remove" ]]; then
    new="$(edit_applets remove)"
    [[ -n "$new" ]] && gs set org.cinnamon enabled-applets "$new"
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
    gs set org.cinnamon enabled-applets "$new"
    msg="installed"
else
    # already on the panel, just reload it
    [[ -n "$LIVE" ]] && gdbus call --session --dest org.Cinnamon --object-path /org/Cinnamon \
        --method org.Cinnamon.ReloadXlet "$UUID" APPLET >/dev/null 2>&1 || true
    msg="updated"
fi
fix_counter
if [[ -n "$LIVE" ]]; then
    echo "$msg, check your panel"
else
    echo "$msg. cinnamon isn't running right now, it'll show up the next time you log in"
fi
