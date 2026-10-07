const Applet = imports.ui.applet;
const AppletManager = imports.ui.appletManager;
const Main = imports.ui.main;
const Settings = imports.ui.settings;
const Tooltips = imports.ui.tooltips;
const Cinnamon = imports.gi.Cinnamon;
const Clutter = imports.gi.Clutter;
const St = imports.gi.St;
const GLib = imports.gi.GLib;
const Gtk = imports.gi.Gtk;
const XApp = imports.gi.XApp;

// we draw the xapp icons ourselves, so the stock applet just stays hidden
const XAPP_UUID = "xapp-status@cinnamon.org";

// whole applets that act like one tray icon
const APPLET_ITEMS = {
    "gpaste": "gpaste-reloaded@feuerfuchs.eu",
    "old-style tray icons": "systray@cinnamon.org",
};

const CELL_PADDING = 14;

// one icon from XApp.StatusIconMonitor (steam, telegram, nm-applet etc)
class XAppIcon {
    constructor(owner, proxy) {
        this.owner = owner;
        this.proxy = proxy;
        this.id = proxy.name.toLowerCase();
        this.size = 16;
        this.inPopup = false;
        this._loadHandle = null;

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
        this.actor.add_actor(this._holder);

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
            if ("Visible" in names)
                this.owner._relayout();
            if ("PrimaryMenuIsOpen" in names || "SecondaryMenuIsOpen" in names)
                this.actor.sync_hover();
        });

        this._updateTooltip();
    }

    get visible() {
        return this.proxy.visible;
    }

    setSize(size) {
        if (size === this.size && this._holder.child)
            return;
        this.size = size;
        this._updateIcon();
    }

    _updateIcon() {
        let name = this.proxy.icon_name;
        if (!name) {
            this._holder.child = null;
            return;
        }
        let symbolic = name.includes("symbolic");
        this.proxy.icon_size = this.size;

        // some apps (steam...) hand us a png path instead of a theme icon.
        // load it into a size x size square so a huge image can't blow up the panel
        if (name.includes("/") && !symbolic) {
            this._loadHandle = St.TextureCache.get_default().load_image_from_file_async(
                name, this.size, this.size, (cache, handle, actor) => {
                    if (handle === this._loadHandle)
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
        this._tooltip.set_markup(text);
        this._tooltip.preventShow = !text;
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
            // the app's own menu needs the mouse, so let go of ours first
            if (this.inPopup)
                this.owner._releaseGrab();
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
        this.proxy.disconnect(this._propsId);
        this._tooltip.destroy();
        this.actor.destroy();
    }
}

class TrayCollapseApplet extends Applet.Applet {
    constructor(metadata, orientation, panelHeight, instanceId) {
        super(orientation, panelHeight, instanceId);
        this._orientation = orientation;
        this._reapplyId = 0;
        this._enforceId = 0;
        this._regrabId = 0;
        this._lastIconClick = 0;
        this._grabbed = false;
        this._closeSignals = [];
        this._xappIcons = new Map();   // key: bus name + path
        this._borrowed = [];           // [applet, cell] currently in the pop-up
        this._hiddenApplets = new Set();
        this._watched = new Map();     // applet -> signal ids
        this._popupItems = [];
        this._origIconSize = new Map();  // applet icon -> its own size, while it's in the pop-up

        this.settings = new Settings.AppletSettings(this, metadata.uuid, instanceId);
        this.settings.bind("icon-size", "iconSize", () => this._relayout());
        this.settings.bind("one-row", "oneRow", () => this._relayout());
        this.settings.bind("columns", "columns", () => this._relayout());
        this.settings.bind("icons", "iconList", () => this._relayout());
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
            [Main.systrayManager, Main.systrayManager.connect("changed", () => this._relayout())],
            [this.panel, this.panel.connect("icon-size-changed", () => this._relayout())],
            [global.settings, global.settings.connect("changed::panel-edit-mode", () => this._onEditModeChanged())],
            // tray applets can load after us, so redo things when the panel changes
            [global.settings, global.settings.connect("changed::enabled-applets", () => {
                this.menu.close();
                this._scheduleReapply();
            })],
        ];

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
        this._relayout();
    }

    _onIconRemoved(proxy) {
        let key = this._key(proxy);
        let icon = this._xappIcons.get(key);
        if (!icon)
            return;
        icon.destroy();
        this._xappIcons.delete(key);
        this._relayout();
    }

    // apps that have their own cinnamon applet (sound, network...) stay out, same as the stock tray
    _isIgnored(icon) {
        return Main.systrayManager.getRoles().includes(icon.id);
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

    // settings list, with anything new added at the end. only writes when something changed,
    // a write while the settings window is open makes it refresh
    _entries(items) {
        let changed = false;
        let list = (Array.isArray(this.iconList) ? this.iconList : []).map(e => {
            // 3.0 had a single "where" field
            if (e.where !== undefined || e.show === undefined) {
                changed = true;
                return {
                    name: e.name,
                    show: e.where !== "hidden",
                    pinned: e.where === "panel" || e.where === "panel-right" || !!e.pinned,
                    right: e.where === "panel-right" || !!e.right,
                };
            }
            return e;
        });
        let known = new Set(list.map(e => e.name));
        for (let item of items) {
            if (!known.has(item.id)) {
                list.push({ name: item.id, show: true, pinned: false, right: false });
                known.add(item.id);
                changed = true;
            }
        }
        if (changed)
            this.settings.setValue("icons", list);
        return list;
    }

    // ---- layout ----

    _relayout() {
        let items = this._items();
        let byId = new Map(items.map(i => [i.id, i]));
        let entries = this._entries(items);

        let xapp = AppletManager.getRunningInstancesForUuid(XAPP_UUID).find(a => a.panel === this.panel);
        if (xapp)
            xapp.actor.visible = false;

        let wasOpen = this.menu.isOpen;
        this._returnApplets();

        for (let icon of this._xappIcons.values()) {
            let parent = icon.actor.get_parent();
            if (parent)
                parent.remove_child(icon.actor);
            this._setCellLook(icon.actor, false);
            icon.inPopup = false;
        }

        let panelSize = (icon) => this.getPanelIconSize(
            (icon.proxy.icon_name || "").includes("symbolic") ? St.IconType.SYMBOLIC : St.IconType.FULLCOLOR);

        this._popupItems = [];
        this._hiddenApplets.clear();
        for (let entry of entries) {
            let item = byId.get(entry.name);
            if (!item)
                continue;
            let onPanel = entry.show && entry.pinned;

            if (item.xapp) {
                if (onPanel) {
                    item.xapp.setSize(panelSize(item.xapp));
                    (entry.right ? this._pinnedRight : this._pinnedLeft).add_actor(item.xapp.actor);
                } else if (entry.show) {
                    item.xapp.setSize(this.iconSize);
                    this._popupItems.push(item);
                }
                continue;
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
        }

        if (wasOpen)
            this._fillPopup();
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
                if (actor.is_finalized() || actor.get_parent() !== applet._panelLocation)
                    continue;
                if (actor.visible && !(applet.menu && applet.menu.isOpen))
                    actor.visible = false;
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _scheduleReapply() {
        if (this._reapplyId)
            GLib.source_remove(this._reapplyId);
        this._reapplyId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => {
            this._reapplyId = 0;
            this._relayout();
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
                this._setCellLook(item.xapp.actor, true);
                item.xapp.inPopup = true;
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
    // an applet is put inside one and scaled so its icon matches the others.
    // the only things changed on the applet are scale and its own hover, both reset on return
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
                let loc = applet._panelLocation;
                let before = loc.get_children().find(x =>
                    x._applet && x._applet instanceof Applet.Applet && applet._order < x._applet._order);
                if (before)
                    loc.insert_child_below(actor, before);
                else
                    loc.add_actor(actor);
                actor.visible = !this._hiddenApplets.has(applet);
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
            this._grabbed = Main.pushModal(this.menu.actor);
            this._connectCloseSignals();
        } else {
            this._releaseGrab();
            Main.layoutManager.untrackChrome(this.menu.actor);
            this._disconnectCloseSignals();
            this._returnApplets();
        }
        this._updateArrow();
    }

    _releaseGrab() {
        this._stopRegrab();
        if (this._grabbed) {
            this._grabbed = false;
            Main.popModal(this.menu.actor);
        }
    }

    _afterIconClick() {
        this._lastIconClick = GLib.get_monotonic_time();
        if (this.closeOnClick) {
            this.menu.close();
            return;
        }
        // stay open. take the mouse back once the app is done with it: grabbing
        // fails while the app's menu is up, so just keep trying until it works
        this._stopRegrab();
        this._regrabId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
            if (!this.menu.isOpen || this._grabbed) {
                this._regrabId = 0;
                return GLib.SOURCE_REMOVE;
            }
            this._grabbed = Main.pushModal(this.menu.actor);
            if (this._grabbed) {
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

    _connectCloseSignals() {
        this._closeSignals = [
            [global.stage, global.stage.connect("captured-event", (actor, event) => {
                let type = event.type();
                if (type === Clutter.EventType.BUTTON_PRESS && !this._isInsideMenuOrSelf(event.get_source())) {
                    // like any other menu: a click outside just closes it
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
        // clicks on pinned icons land here too
        if (!this._arrow.contains(event.get_source()))
            return;
        if (this.menu.isOpen) {
            this.menu.close();
        } else {
            this._fillPopup();
            this.menu.open();
        }
    }

    on_orientation_changed(orientation) {
        this._orientation = orientation;
        this.menu.close();
        this._updateArrow();
        this._relayout();
    }

    on_panel_height_changed() {
        this._updateArrow();
        this._relayout();
    }

    on_applet_removed_from_panel() {
        this.menu.close();
        for (let id of [this._reapplyId, this._enforceId, this._regrabId])
            if (id)
                GLib.source_remove(id);
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
