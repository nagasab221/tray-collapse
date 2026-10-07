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

## Tweaking

- Want another applet in the pop-up? Add its uuid to `TARGET_UUIDS` at the top of `applet.js`.
- Icon size, hover color, fade speed are in `stylesheet.css`.

Tested on Linux Mint 22.3 with Cinnamon 6.6. Should work on other Cinnamon setups but
I haven't tried.
