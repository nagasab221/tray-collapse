# tray-collapse

I missed the little "show hidden icons" arrow from Windows, so I made one for Cinnamon.

It hides your tray icons from the panel and puts them in a small pop-up that opens when
you click the arrow. Works with the normal tray icons (Steam, Telegram, Discord etc.),
old-style tray icons, and GPaste if you have it.

## Install

```
curl -fsSL https://raw.githubusercontent.com/nagasab221/tray-collapse/main/install.sh | bash
```

No sudo needed. It drops the arrow right next to your tray. Run the same command again
to update.

You can also clone the repo and run `./install.sh` yourself.

## Uninstall

```
curl -fsSL https://raw.githubusercontent.com/nagasab221/tray-collapse/main/install.sh | bash -s -- --remove
```

or `./install.sh --remove`. Your tray icons go back to normal.

## Settings

Right-click the arrow and hit Configure. You can:

- change the icon size in the pop-up
- pick a layout: one row, or 3, 4 or 5 icons per row (3×3, 3×4, 3×5)
- choose per icon whether it goes in the pop-up, stays on the panel (left of the arrow),
  or is hidden completely
- reorder icons with the arrows

New icons show up in the list by themselves the first time an app puts one in the tray.

## Tweaking

- Hover color and fade speed are in `stylesheet.css`.
- Other applets that should act like a tray icon go in `APPLET_ITEMS` at the top of `applet.js`.

Tested on Linux Mint 22.3 with Cinnamon 6.6. Should work on other Cinnamon setups but
I haven't tried.
