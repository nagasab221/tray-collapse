const Applet = imports.ui.applet;
const AppletManager = imports.ui.appletManager;
const Extension = imports.ui.extension;
const Main = imports.ui.main;
const Settings = imports.ui.settings;
const Tooltips = imports.ui.tooltips;
const Cinnamon = imports.gi.Cinnamon;
const Clutter = imports.gi.Clutter;
const St = imports.gi.St;
const GLib = imports.gi.GLib;
const Gtk = imports.gi.Gtk;
const Pango = imports.gi.Pango;
const XApp = imports.gi.XApp;

// we draw the xapp icons ourselves, so the stock applet just stays hidden
const XAPP_UUID = "xapp-status@cinnamon.org";

// whole applets that act like one tray icon
const APPLET_ITEMS = {
    "gpaste": "gpaste-reloaded@feuerfuchs.eu",
    "old-style tray icons": "systray@cinnamon.org",
};

// names with a process id in them change every launch (electron apps, claude...)
const GENERIC_NAME = /^(org\.(freedesktop|kde)\.statusnotifieritem-\d+-\d+|chrome_status_icon_\d+)$/;

const CELL_PADDING = 14;

// one icon from XApp.StatusIconMonitor (steam, telegram, nm-applet etc)
class XAppIcon {
    constructor(owner, proxy) {
        this.owner = owner;
        this.proxy = proxy;
        this.size = 0;
        this.inPopup = false;
        this.destroyed = false;
        this._loadHandle = null;
        this.id = this._computeId();

        this.actor = new St.BoxLayout({
            style_class: "applet-box",
            reactive: !global.settings.get_boolean("panel-edit-mode"),
            track_hover: true,
        });
        // whatever the app sends, it can't grow past its box
        this.actor.set_clip_to_allocation(true);
        this._holder = new St.Bin({
            x_expand: true, y_expand: true,
            x_align: St.Align.MIDDLE, y_align: St.Align.MIDDLE,
            x_fill: false, y_fill: false,
        });
        this._label = new St.Label({ y_align: Clutter.ActorAlign.CENTER, visible: false });
        this.actor.add_actor(this._holder);
        this.actor.add_actor(this._label);

        this._tooltip = new Tooltips.Tooltip(this.actor, "");

        this.actor.connect("button-press-event", (a, e) => this._onButton(e, true));
        this.actor.connect("button-release-event", (a, e) => this._onButton(e, false));
        this.actor.connect("scroll-event", (a, e) => this._onScroll(e));
        this._propsId = proxy.connect("g-properties-changed", (p, changed) => {
            let names = changed.deep_unpack();
            if ("IconName" in names)
                this._updateIcon();
            if ("TooltipText" in names)
                this._updateTooltip();
            if ("Label" in names)
                this._updateLabel();
            if ("PrimaryMenuIsOpen" in names || "SecondaryMenuIsOpen" in names)
                this.actor.sync_hover();

            let id = this._computeId();
            if ("Visible" in names || id !== this.id) {
                this.id = id;
                this.owner._queueRelayout();
            }
        });

        this._updateTooltip();
        this._updateLabel();
    }

    // what the settings list remembers this icon by. null = nothing stable yet
    _computeId() {
        let name = (this.proxy.name || "").toLowerCase();
        if (name && !GENERIC_NAME.test(name))
            return name;
        // the tooltip is steadier for those ("Discord", "Claude"). first part only,
        // so "Discord - 3 mentions" stays "discord"
        let tip = (this.proxy.tooltip_text || "").replace(/<[^>]*>/g, "").split("\n")[0];
        tip = tip.split(/\s+[-–—|(:]/)[0].trim().toLowerCase();
        if (tip)
            return tip;
        let icon = this.proxy.icon_name || "";
        if (icon && !icon.includes("/"))
            return icon.toLowerCase();
        return null;
    }

    get visible() {
        return this.proxy.visible;
    }

    setPlacement(inPopup, size) {
        this.inPopup = inPopup;
        this._updateLabel();
        if (size === this.size && this._holder.child)
            return;
        // a hint for apps that send image files, so they render at the right size
        if (size !== this.size)
            this.proxy.icon_size = size;
        this.size = size;
        this._updateIcon();
    }

    _updateIcon() {
        if (this.destroyed || !this.size)
            return;
        let name = this.proxy.icon_name;
        if (!name) {
            this._holder.child = null;
            return;
        }
        let symbolic = name.includes("symbolic");

        // some apps (steam...) hand us a png path instead of a theme icon.
        // load it into a size x size square so a huge image can't blow up the panel
        if (name.includes("/") && !symbolic) {
            this._loadHandle = St.TextureCache.get_default().load_image_from_file_async(
                name, this.size, this.size, (cache, handle, actor) => {
                    // the icon may be gone by the time the file is loaded
                    if (!this.destroyed && handle === this._loadHandle)
                        this._holder.child = actor;
                });
            return;
        }
        this._holder.child = new St.Icon({
            icon_name: name,
            icon_size: this.size,
            icon_type: symbolic ? St.IconType.SYMBOLIC : St.IconType.FULLCOLOR,
        });
    }

    _updateTooltip() {
        let text = this.proxy.tooltip_text || "";
        // it's supposed to be markup, but "Tom & Jerry" isn't. show those as plain text
        try {
            Pango.parse_markup(text, -1, "");
            this._tooltip.set_markup(text);
        } catch (e) {
            this._tooltip.set_text(text);
        }
        this._tooltip.preventShow = !text;
    }

    // some apps show text next to the icon (a counter, a clock). only on the panel, like the
    // stock tray, the pop-up keeps everything square
    _updateLabel() {
        let text = this.proxy.label || "";
        let horizontal = this.owner._orientation === St.Side.TOP || this.owner._orientation === St.Side.BOTTOM;
        this._label.text = text;
        this._label.visible = !!text && !this.inPopup && horizontal;
    }

    // where the app should open its menu
    _position() {
        let box = Cinnamon.util_get_transformed_allocation(this.actor);
        let s = global.ui_scale;
        let [x, y] = [Math.round(box.x1 / s), Math.round(box.y1 / s)];
        let [w, h] = [Math.round((box.x2 - box.x1) / s), Math.round((box.y2 - box.y1) / s)];
        switch (this.owner._orientation) {
            case St.Side.TOP:   return [x, y + h, Gtk.PositionType.TOP];
            case St.Side.LEFT:  return [x + w, y, Gtk.PositionType.LEFT];
            case St.Side.RIGHT: return [x, y, Gtk.PositionType.RIGHT];
            default:            return [x, y, Gtk.PositionType.BOTTOM];
        }
    }

    _onButton(event, pressed) {
        // ctrl+right click on a pinned icon = the normal panel menu
        if (event.get_button() === Clutter.BUTTON_SECONDARY && (event.get_state() & Clutter.ModifierType.CONTROL_MASK))
            return Clutter.EVENT_PROPAGATE;
        this._tooltip.hide();
        let [x, y, o] = this._position();
        if (pressed) {
            // the app's own menu needs the mouse, so let go of ours first.
            // some apps already act on the press (open a window), so count the click from here
            if (this.inPopup)
                this.owner._onIconPress();
            this.proxy.call_button_press(x, y, event.get_button(), event.get_time(), o, null, null);
        } else {
            this.proxy.call_button_release(x, y, event.get_button(), event.get_time(), o, null, null);
            if (this.inPopup)
                this.owner._afterIconClick();
        }
        return Clutter.EVENT_STOP;
    }

    _onScroll(event) {
        let dirs = {
            [Clutter.ScrollDirection.UP]: [XApp.ScrollDirection.UP, -1],
            [Clutter.ScrollDirection.DOWN]: [XApp.ScrollDirection.DOWN, 1],
            [Clutter.ScrollDirection.LEFT]: [XApp.ScrollDirection.LEFT, -1],
            [Clutter.ScrollDirection.RIGHT]: [XApp.ScrollDirection.RIGHT, 1],
        };
        let d = dirs[event.get_scroll_direction()];
        if (d)
            this.proxy.call_scroll(d[1], d[0], event.get_time(), null, null);
        return Clutter.EVENT_STOP;
    }

    destroy() {
        this.destroyed = true;
        this._loadHandle = null;
        this.proxy.disconnect(this._propsId);
        this._tooltip.destroy();
        this.actor.destroy();
    }
}

class TrayCollapseApplet extends Applet.Applet {
    constructor(metadata, orientation, panelHeight, instanceId) {
        super(orientation, panelHeight, instanceId);
        this.setAllowedLayout(Applet.AllowedLayout.BOTH);
        this._orientation = orientation;

        // two of us on one panel would fight over the same icons. the second one does nothing.
        // (not max-instances 1: that makes cinnamon move the settings to a new file)
        this._inert = AppletManager.getRunningInstancesForUuid(metadata.uuid)
            .some(a => a !== this && a.panel === this.panel && !a._inert);
        if (this._inert) {
            this.actor.add_actor(new St.Icon({
                icon_name: "dialog-warning-symbolic",
                icon_type: St.IconType.SYMBOLIC,
                icon_size: this.getPanelIconSize(St.IconType.SYMBOLIC),
            }));
            this.set_applet_tooltip(_("Tray Collapse is already on this panel, this one does nothing"));
            return;
        }

        this._relayoutId = 0;
        this._reapplyId = 0;
        this._reapplyTries = 0;
        this._enforceId = 0;
        this._regrabId = 0;
        this._swallow = null;          // [signal id, timeout id] eating the release of a closing click
        this._lastIconClick = 0;
        this._grabbed = false;
        this._closeSignals = [];
        this._xappIcons = new Map();   // key: bus name + path
        this._borrowed = [];           // [applet, cell, hadTrackHover] currently in the pop-up
        this._hiddenApplets = new Set();
        this._watched = new Map();     // applet -> signal ids
        this._popupItems = [];
        this._origIconSize = new Map();  // applet icon -> its own size, while it's in the pop-up

        this.settings = new Settings.AppletSettings(this, metadata.uuid, instanceId);
        this.settings.bind("icon-size", "iconSize", () => this._queueRelayout());
        this.settings.bind("one-row", "oneRow", () => this._queueRelayout());
        this.settings.bind("columns", "columns", () => this._queueRelayout());
        this.settings.bind("icons", "iconList", () => this._queueRelayout());
        this.settings.bind("close-on-click", "closeOnClick");

        // panel: [pinned left][arrow][pinned right]
        this.actor.remove_style_class_name("applet-box");
        this._pinnedLeft = new St.BoxLayout();
        this._pinnedRight = new St.BoxLayout();
        this._arrow = new St.BoxLayout({ style_class: "applet-box", reactive: true, track_hover: true });
        this._arrowIcon = new St.Icon({ icon_type: St.IconType.SYMBOLIC, style_class: "applet-icon" });
        this._arrow.add_actor(this._arrowIcon);
        this.actor.add_actor(this._pinnedLeft);
        this.actor.add_actor(this._arrow);
        this.actor.add_actor(this._pinnedRight);
        this._arrowTooltip = new Tooltips.Tooltip(this._arrow, _("Show hidden icons"));
        // the arrow has its own tooltip, the pinned icons have theirs
        this._applet_tooltip.preventShow = true;

        // no PopupMenuManager: we grab the mouse ourselves so we can let go
        // when an app icon needs to open its own menu
        this.menu = new Applet.AppletPopupMenu(this, orientation);
        this.menu.connect("open-state-changed", (menu, open) => this._onOpenStateChanged(open));
        this._grid = new Clutter.GridLayout({ column_spacing: 4, row_spacing: 4 });
        this._gridBox = new St.Widget({ layout_manager: this._grid, style_class: "tray-collapse-box" });
        this._emptyLabel = new St.Label({ text: _("No hidden icons"), style_class: "tray-collapse-empty" });
        this.menu.box.add_actor(this._gridBox);
        this.menu.box.add_actor(this._emptyLabel);

        this._monitor = new XApp.StatusIconMonitor();
        this._signals = [
            [this._monitor, this._monitor.connect("icon-added", (m, proxy) => this._onIconAdded(proxy))],
            [this._monitor, this._monitor.connect("icon-removed", (m, proxy) => this._onIconRemoved(proxy))],
            [Main.systrayManager, Main.systrayManager.connect("changed", () => this._queueRelayout())],
            [this.panel, this.panel.connect("icon-size-changed", () => {
                this._updateArrow();
                this._queueRelayout();
            })],
            [global.settings, global.settings.connect("changed::panel-edit-mode", () => this._onEditModeChanged())],
            // tray applets can load after us, so redo things when the panel changes
            [global.settings, global.settings.connect("changed::enabled-applets", () => {
                this.menu.close();
                this._scheduleReapply();
            })],
            // ...or get reloaded (an update), which makes a fresh, visible copy of them
            [Extension.Type.APPLET, Extension.Type.APPLET.connect("extension-loaded", (type, uuid) => {
                if (uuid === XAPP_UUID || Object.values(APPLET_ITEMS).includes(uuid)) {
                    this.menu.close();
                    this._scheduleReapply();
                }
            })],
        ];

        this._applyOrientation();
        this._scheduleReapply();
        this._updateArrow();
    }

    // ---- items ----

    _key(proxy) {
        return proxy.get_name() + proxy.get_object_path();
    }

    _onIconAdded(proxy) {
        let key = this._key(proxy);
        if (this._xappIcons.has(key))
            return;
        this._xappIcons.set(key, new XAppIcon(this, proxy));
        this._queueRelayout();
    }

    _onIconRemoved(proxy) {
        let key = this._key(proxy);
        let icon = this._xappIcons.get(key);
        if (!icon)
            return;
        icon.destroy();
        this._xappIcons.delete(key);
        this._queueRelayout();
    }

    // apps that have their own cinnamon applet (sound, network...) stay out, same as the stock tray
    _isIgnored(icon) {
        return icon.id !== null && Main.systrayManager.getRoles().includes(icon.id);
    }

    _appletFor(uuid) {
        return AppletManager.getRunningInstancesForUuid(uuid).find(a => a.panel === this.panel && a._panelLocation);
    }

    // everything we can place right now, as {id, xapp} or {id, applet}
    _items() {
        let items = [];
        for (let icon of this._xappIcons.values())
            if (icon.visible && !this._isIgnored(icon))
                items.push({ id: icon.id, xapp: icon });
        for (let [id, uuid] of Object.entries(APPLET_ITEMS)) {
            let applet = this._appletFor(uuid);
            if (applet)
                items.push({ id, applet });
        }
        return items;
    }

    // settings list: cleaned up, with anything new added at the end. only writes when
    // something changed, a write while the settings window is open makes it refresh
    _entries(items) {
        let changed = false;
        let seen = new Set();
        let list = [];
        for (let e of Array.isArray(this.iconList) ? this.iconList : []) {
            // junk or a second entry for the same icon
            if (!e || typeof e.name !== "string" || !e.name || seen.has(e.name)) {
                changed = true;
                continue;
            }
            seen.add(e.name);
            // 3.0 had a single "where" field
            if (e.where !== undefined || e.show === undefined) {
                changed = true;
                e = {
                    name: e.name,
                    show: e.where !== "hidden",
                    pinned: e.where === "panel" || e.where === "panel-right" || !!e.pinned,
                    right: e.where === "panel-right" || !!e.right,
                };
            }
            list.push(e);
        }
        for (let item of items) {
            if (item.id !== null && !seen.has(item.id)) {
                list.push({ name: item.id, show: true, pinned: false, right: false });
                seen.add(item.id);
                changed = true;
            }
        }
        if (changed)
            this.settings.setValue("icons", list);
        return list;
    }

    // ---- layout ----

    // lots of things can change at once (startup, an app adding three icons), do it once
    _queueRelayout() {
        if (this._relayoutId)
            return;
        this._relayoutId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._relayoutId = 0;
            this._relayout();
            return GLib.SOURCE_REMOVE;
        });
    }

    _relayout() {
        if (this._relayoutId) {
            GLib.source_remove(this._relayoutId);
            this._relayoutId = 0;
        }
        let items = this._items();
        let entries = this._entries(items);
        // an app can have two icons with the same name, both get the same treatment
        let byId = new Map();
        for (let item of items) {
            if (!byId.has(item.id))
                byId.set(item.id, []);
            byId.get(item.id).push(item);
        }

        let wasOpen = this.menu.isOpen;
        this._returnApplets();
        this._hiddenApplets.clear();

        // the stock tray would show the same icons again
        let xappApplet = this._appletFor(XAPP_UUID);
        if (xappApplet) {
            this._watchApplet(xappApplet);
            this._hiddenApplets.add(xappApplet);
            xappApplet.actor.visible = false;
        }

        let panelSize = (icon) => this.getPanelIconSize(
            (icon.proxy.icon_name || "").includes("symbolic") ? St.IconType.SYMBOLIC : St.IconType.FULLCOLOR);

        let left = [], right = [];
        this._popupItems = [];
        let place = (item, entry) => {
            let onPanel = entry.show && entry.pinned;
            if (item.xapp) {
                if (onPanel) {
                    item.xapp.setPlacement(false, panelSize(item.xapp));
                    (entry.right ? right : left).push(item.xapp.actor);
                } else if (entry.show) {
                    item.xapp.setPlacement(true, this.iconSize);
                    this._popupItems.push(item);
                }
                return;
            }
            let applet = item.applet;
            this._watchApplet(applet);
            if (onPanel) {
                applet.actor.visible = true;
                let loc = applet._panelLocation;
                if (applet.actor.get_parent() === loc && this.actor.get_parent() === loc) {
                    if (entry.right)
                        loc.set_child_above_sibling(applet.actor, this.actor);
                    else
                        loc.set_child_below_sibling(applet.actor, this.actor);
                }
            } else {
                this._hiddenApplets.add(applet);
                applet.actor.visible = false;
                if (entry.show)
                    this._popupItems.push(item);
            }
        };
        for (let entry of entries)
            for (let item of byId.get(entry.name) || [])
                place(item, entry);
        // nothing stable to remember it by yet: just show it in the pop-up
        for (let item of byId.get(null) || [])
            place(item, { show: true, pinned: false, right: false });

        // pinned icons: only touch the panel if something actually moved
        this._syncBox(this._pinnedLeft, left);
        this._syncBox(this._pinnedRight, right);
        let pinned = new Set([...left, ...right]);
        let inPopup = new Set(this._popupItems.filter(i => i.xapp).map(i => i.xapp.actor));
        for (let icon of this._xappIcons.values()) {
            let parent = icon.actor.get_parent();
            // hidden ones, and ones that just left a pinned box
            if (!pinned.has(icon.actor) && !inPopup.has(icon.actor) && parent)
                parent.remove_child(icon.actor);
            if (!inPopup.has(icon.actor))
                this._setCellLook(icon.actor, false);
        }

        if (wasOpen)
            this._fillPopup();
    }

    _syncBox(box, actors) {
        let current = box.get_children();
        if (current.length === actors.length && current.every((a, i) => a === actors[i]))
            return;
        for (let child of current)
            if (!actors.includes(child))
                box.remove_child(child);
        actors.forEach((actor, i) => {
            let parent = actor.get_parent();
            if (parent !== box) {
                if (parent)
                    parent.remove_child(actor);
                box.insert_child_at_index(actor, i);
            } else {
                box.set_child_at_index(actor, i);
            }
        });
    }

    // some applets show themselves (gpaste does when its shortcut opens its menu).
    // fine while their menu is open, after that they go back to hidden
    _watchApplet(applet) {
        if (this._watched.has(applet))
            return;
        let ids = [[applet.actor, applet.actor.connect("notify::visible", () => this._queueEnforce())]];
        if (applet.menu && applet.menu.connect)
            ids.push([applet.menu, applet.menu.connect("open-state-changed", (m, open) => {
                this._queueEnforce();
                if (!open && this.closeOnClick && this.menu.isOpen && this._borrowed.some(([a]) => a === applet))
                    this.menu.close();
            })]);
        ids.push([applet.actor, applet.actor.connect("destroy", () => this._watched.delete(applet))]);
        this._watched.set(applet, ids);
    }

    _queueEnforce() {
        if (this._enforceId)
            return;
        // after the applet's own handlers are done
        this._enforceId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._enforceId = 0;
            for (let applet of this._hiddenApplets) {
                let actor = applet.actor;
                if (actor.is_finalized() || !applet._panelLocation || actor.get_parent() !== applet._panelLocation)
                    continue;
                if (actor.visible && !(applet.menu && applet.menu.isOpen))
                    actor.visible = false;
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    // tray applets on our panel that are set up but haven't loaded yet (slow login)
    _trayAppletsMissing() {
        let panelKey = "panel" + this.panel.panelId;
        let wanted = [XAPP_UUID, ...Object.values(APPLET_ITEMS)];
        return global.settings.get_strv("enabled-applets").some(def => {
            let [panel, , , uuid] = def.split(":");
            return panel === panelKey && wanted.includes(uuid) && !this._appletFor(uuid);
        });
    }

    _scheduleReapply(retry = false) {
        if (this._reapplyId)
            GLib.source_remove(this._reapplyId);
        if (!retry)
            this._reapplyTries = 0;
        this._reapplyId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, retry ? 2000 : 1500, () => {
            this._reapplyId = 0;
            this._relayout();
            // keep checking for a bit, then give up (one may just be broken)
            if (this._trayAppletsMissing() && ++this._reapplyTries < 10)
                this._scheduleReapply(true);
            return GLib.SOURCE_REMOVE;
        });
    }

    _cellSize() {
        return this.iconSize + CELL_PADDING;
    }

    _setCellLook(actor, inPopup) {
        // same fixed square for every pop-up icon
        if (inPopup) {
            let s = this._cellSize();
            actor.add_style_class_name("tray-collapse-cell");
            actor.set_size(s, s);
        } else {
            actor.remove_style_class_name("tray-collapse-cell");
            actor.set_size(-1, -1);
        }
    }

    // ---- pop-up ----

    _fillPopup() {
        this._returnApplets();
        for (let child of this._gridBox.get_children())
            this._gridBox.remove_child(child);

        let cells = [];
        for (let item of this._popupItems) {
            if (item.xapp) {
                // removed since the last layout, the queued one will catch up
                if (item.xapp.destroyed)
                    continue;
                let parent = item.xapp.actor.get_parent();
                if (parent)
                    parent.remove_child(item.xapp.actor);
                this._setCellLook(item.xapp.actor, true);
                cells.push(item.xapp.actor);
            } else {
                let cell = this._borrowApplet(item.applet);
                if (cell)
                    cells.push(cell);
            }
        }

        let cols = this.oneRow ? Math.max(cells.length, 1) : Math.max(this.columns, 1);
        cells.forEach((cell, i) => this._grid.attach(cell, i % cols, Math.floor(i / cols), 1, 1));

        this._gridBox.visible = cells.length > 0;
        this._emptyLabel.visible = cells.length === 0;
    }

    // panel -> pop-up. every pop-up icon gets the same cell: our size, our hover.
    // an applet is put inside one and its icon redrawn at the pop-up size.
    // only its icon size and own hover are changed, both put back on return
    _borrowApplet(applet) {
        let actor = applet.actor;
        let parent = actor.get_parent();
        // no parent = got orphaned somehow, just take it
        if (parent && parent !== applet._panelLocation)
            return null;

        // old-style tray: a box of icons, only worth showing if it has any
        let [, natW] = actor.get_preferred_width(-1);
        let [, natH] = actor.get_preferred_height(-1);
        if (natW <= 0 || natH <= 0)
            return null;

        if (parent)
            parent.remove_actor(actor);

        let isTray = !actor.has_style_class_name("applet-box");
        let cell = new St.Bin({
            reactive: true, track_hover: true,
            x_align: St.Align.MIDDLE, y_align: St.Align.MIDDLE,
            x_fill: false, y_fill: false,
        });
        cell.set_clip_to_allocation(true);
        cell.set_child(actor);

        // one highlight per icon: ours
        let hadTrackHover = actor.track_hover;
        actor.track_hover = false;
        actor.hover = false;

        if (isTray) {
            // a group of icons, can't be squeezed into one square
            cell.add_style_class_name("tray-collapse-cell");
        } else {
            this._setCellLook(cell, true);
            let icon = this._appletIcon(applet);
            if (icon) {
                // redraw its icon at our size so it's as sharp as the others.
                // the original is only saved once, so a missed return can't save our size
                if (!this._origIconSize.has(icon))
                    this._origIconSize.set(icon, icon.icon_size);
                icon.icon_size = this.iconSize;
            } else {
                // no icon (text applet)? shrink the whole thing to fit
                let scale = Math.min(1, this._cellSize() / natW, this._cellSize() / natH);
                actor.set_pivot_point(0.5, 0.5);
                actor.set_scale(scale, scale);
            }
            // clicks on the empty part of the cell count too, like the app icons
            cell.connect("button-press-event", (a, event) =>
                event.get_source() === cell ? applet._onButtonPressEvent(actor, event) : Clutter.EVENT_PROPAGATE);
        }
        actor.visible = true;
        this._borrowed.push([applet, cell, hadTrackHover]);
        return cell;
    }

    // the applet's own icon, if it has one
    _appletIcon(applet) {
        if (applet._applet_icon instanceof St.Icon)
            return applet._applet_icon;
        let find = (a) => {
            if (a instanceof St.Icon)
                return a;
            for (let c of a.get_children()) {
                let found = find(c);
                if (found)
                    return found;
            }
            return null;
        };
        return find(applet.actor);
    }

    // pop-up -> back to the same spot on the panel
    _returnApplets() {
        for (let [applet, cell, hadTrackHover] of this._borrowed) {
            let actor = applet.actor;
            if (!actor.is_finalized() && actor.get_parent() === cell) {
                cell.set_child(null);
                actor.set_scale(1, 1);
                actor.track_hover = hadTrackHover;
                // removed from the panel while it was in here: nowhere to go back to
                let loc = applet._panelLocation;
                if (loc && !loc.is_finalized()) {
                    let before = loc.get_children().find(x =>
                        x._applet && x._applet instanceof Applet.Applet && applet._order < x._applet._order);
                    if (before)
                        loc.insert_child_below(actor, before);
                    else
                        loc.add_actor(actor);
                    actor.visible = !this._hiddenApplets.has(applet);
                }
            }
            cell.destroy();
        }
        this._borrowed = [];
        for (let [icon, size] of this._origIconSize)
            if (!icon.is_finalized())
                icon.icon_size = size;
        this._origIconSize.clear();
    }

    _onOpenStateChanged(open) {
        if (open) {
            // keeps mouse events coming up here even after we let go of the grab
            Main.layoutManager.trackChrome(this.menu.actor, { affectsInputRegion: true });
            this._connectCloseSignals();
            // something else may have the mouse right now (a drag, another app's menu)
            if (!this._tryGrab())
                this._startRegrab();
        } else {
            this._releaseGrab();
            Main.layoutManager.untrackChrome(this.menu.actor);
            this._disconnectCloseSignals();
            this._returnApplets();
            // don't come back highlighted next time
            for (let item of this._popupItems)
                if (item.xapp && !item.xapp.destroyed)
                    item.xapp.actor.hover = false;
        }
        this._updateArrow();
    }

    // grabbing fails while an app's own menu has the mouse. check quietly first,
    // Main.pushModal logs an error every time it fails
    _tryGrab() {
        if (Main.modalCount === 0) {
            let time = global.get_current_time();
            if (!global.begin_modal(time, 0))
                return false;
            global.end_modal(time);
        }
        this._grabbed = Main.pushModal(this.menu.actor);
        return this._grabbed;
    }

    _releaseGrab() {
        this._stopRegrab();
        if (this._grabbed) {
            this._grabbed = false;
            Main.popModal(this.menu.actor);
        }
    }

    _onIconPress() {
        this._lastIconClick = GLib.get_monotonic_time();
        this._releaseGrab();
        // the release may never reach us (the app's new window can end up under the mouse),
        // so don't wait for it to start taking the mouse back
        if (!this.closeOnClick)
            this._startRegrab();
    }

    _afterIconClick() {
        this._lastIconClick = GLib.get_monotonic_time();
        if (this.closeOnClick)
            this.menu.close();
        else
            this._startRegrab();
    }

    // stay open, and take the mouse back once whoever has it is done
    _startRegrab() {
        this._stopRegrab();
        this._regrabId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
            if (!this.menu.isOpen || this._grabbed || this._tryGrab()) {
                this._regrabId = 0;
                return GLib.SOURCE_REMOVE;
            }
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopRegrab() {
        if (this._regrabId) {
            GLib.source_remove(this._regrabId);
            this._regrabId = 0;
        }
    }

    _isInsideMenuOrSelf(actor) {
        for (let a = actor; a; a = a.get_parent()) {
            if (a === this._arrow || a === this.menu.actor)
                return true;
            // an applet's own menu (gpaste history etc)
            if (a instanceof St.Widget && a.has_style_class_name("menu"))
                return true;
        }
        return false;
    }

    // the click that closes the pop-up shouldn't also land on what's under it
    // (the window list switches windows on release)
    _swallowNextRelease() {
        this._stopSwallow();
        let id = global.stage.connect("captured-event", (actor, event) => {
            if (event.type() !== Clutter.EventType.BUTTON_RELEASE)
                return Clutter.EVENT_PROPAGATE;
            this._stopSwallow();
            return Clutter.EVENT_STOP;
        });
        let timeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2000, () => {
            this._swallow[1] = 0;
            this._stopSwallow();
            return GLib.SOURCE_REMOVE;
        });
        this._swallow = [id, timeout];
    }

    _stopSwallow() {
        if (!this._swallow)
            return;
        let [id, timeout] = this._swallow;
        global.stage.disconnect(id);
        if (timeout)
            GLib.source_remove(timeout);
        this._swallow = null;
    }

    _connectCloseSignals() {
        this._closeSignals = [
            [global.stage, global.stage.connect("captured-event", (actor, event) => {
                let type = event.type();
                if (type === Clutter.EventType.BUTTON_PRESS && !this._isInsideMenuOrSelf(event.get_source())) {
                    // like any other menu: a click outside just closes it
                    this._swallowNextRelease();
                    this.menu.close();
                    return Clutter.EVENT_STOP;
                }
                if (type === Clutter.EventType.KEY_PRESS && event.get_key_symbol() === Clutter.KEY_Escape) {
                    this.menu.close();
                    return Clutter.EVENT_STOP;
                }
                return Clutter.EVENT_PROPAGATE;
            })],
            // backup for when we let go of the grab for an app menu.
            // right after an icon click the app itself may grab focus, ignore that
            [global.display, global.display.connect("notify::focus-window", () => {
                let recent = GLib.get_monotonic_time() - this._lastIconClick < 1500000;
                if (!this._grabbed && global.display.focus_window && (this.closeOnClick || !recent))
                    this.menu.close();
            })],
        ];
    }

    _disconnectCloseSignals() {
        for (let [obj, id] of this._closeSignals)
            obj.disconnect(id);
        this._closeSignals = [];
    }

    _applyOrientation() {
        let vertical = this._orientation === St.Side.LEFT || this._orientation === St.Side.RIGHT;
        this.actor.vertical = vertical;
        this._pinnedLeft.vertical = vertical;
        this._pinnedRight.vertical = vertical;
    }

    _updateArrow() {
        let open = this.menu.isOpen;
        let icon;
        switch (this._orientation) {
            case St.Side.BOTTOM: icon = open ? "pan-down-symbolic" : "pan-up-symbolic"; break;
            case St.Side.TOP:    icon = open ? "pan-up-symbolic" : "pan-down-symbolic"; break;
            case St.Side.LEFT:   icon = open ? "pan-start-symbolic" : "pan-end-symbolic"; break;
            default:             icon = open ? "pan-end-symbolic" : "pan-start-symbolic"; break;
        }
        this._arrowIcon.icon_name = icon;
        this._arrowIcon.icon_size = this.getPanelIconSize(St.IconType.SYMBOLIC);
        this._arrowTooltip.preventShow = open;
    }

    _onEditModeChanged() {
        let reactive = !global.settings.get_boolean("panel-edit-mode");
        for (let icon of this._xappIcons.values())
            icon.actor.reactive = reactive;
        this.menu.close();
    }

    // ---- applet hooks ----

    on_applet_clicked(event) {
        if (this._inert)
            return;
        // clicks on pinned icons land here too
        if (!this._arrow.contains(event.get_source()))
            return;
        if (this.menu.isOpen) {
            this.menu.close();
        } else {
            this._relayout();
            this._fillPopup();
            this.menu.open();
        }
    }

    on_orientation_changed(orientation) {
        this._orientation = orientation;
        if (this._inert)
            return;
        this.menu.close();
        this._applyOrientation();
        this._updateArrow();
        this._queueRelayout();
    }

    on_panel_height_changed() {
        if (this._inert)
            return;
        this._updateArrow();
        this._queueRelayout();
    }

    on_applet_removed_from_panel() {
        if (this._inert)
            return;
        this.menu.close();
        this._stopSwallow();
        for (let id of [this._relayoutId, this._reapplyId, this._enforceId, this._regrabId])
            if (id)
                GLib.source_remove(id);
        this._relayoutId = this._reapplyId = this._enforceId = this._regrabId = 0;
        for (let [obj, id] of this._signals)
            obj.disconnect(id);
        for (let ids of this._watched.values())
            for (let [obj, id] of ids)
                obj.disconnect(id);
        this._watched.clear();
        for (let icon of this._xappIcons.values())
            icon.destroy();
        this._xappIcons.clear();
        this._monitor = null;

        // give the panel its tray back
        for (let uuid of [XAPP_UUID, ...Object.values(APPLET_ITEMS)])
            for (let applet of AppletManager.getRunningInstancesForUuid(uuid))
                if (applet.panel === this.panel)
                    applet.actor.visible = true;

        this._arrowTooltip.destroy();
        this.settings.finalize();
        this.menu.destroy();
    }
}

function main(metadata, orientation, panelHeight, instanceId) {
    return new TrayCollapseApplet(metadata, orientation, panelHeight, instanceId);
}
