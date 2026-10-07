# Tray Collapse

Windows-style "show hidden icons" arrow for the Cinnamon panel (Linux Mint). The tray icons
(xapp-status, legacy systray, and GPaste Reloaded if present) are hidden from the panel and
shown in a pop-up above the arrow.

## Install / update

One command (Linux Mint / Cinnamon, no sudo):

    curl -fsSL https://raw.githubusercontent.com/nagasab221/tray-collapse/main/install.sh | bash

Or from a clone / extracted download:

    ./install.sh

Copies the applet to `~/.local/share/cinnamon/applets/` and adds it just left of the system
tray. Running it again updates the files and reloads the applet. Per user, no sudo needed.

## Remove

    curl -fsSL https://raw.githubusercontent.com/nagasab221/tray-collapse/main/install.sh | bash -s -- --remove

or `./install.sh --remove`.

## Notes

- Tested on Linux Mint 22.3, Cinnamon 6.6.
- Which applets go in the pop-up: `TARGET_UUIDS` at the top of `applet.js`.
- Look (cell size, hover fade): `stylesheet.css`.
