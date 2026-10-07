const Applet = imports.ui.applet;
const AppletManager = imports.ui.appletManager;
const Main = imports.ui.main;
const Clutter = imports.gi.Clutter;
const St = imports.gi.St;
const GLib = imports.gi.GLib;

// Applets that live in the pop-up instead of the panel.
const TARGET_UUIDS = ["gpaste-reloaded@feuerfuchs.eu", "xapp-status@cinnamon.org", "systray@cinnamon.org"];

// Child properties changed while an icon sits in the pop-up, restored when it goes back.
const CELL_PROPS = ["x_expand", "y_expand", "x_align", "y_align", "x_fill", "y_fill"];

class TrayCollapseApplet extends Applet.IconApplet {
    constructor(metadata, orientation, panelHeight, instanceId) {
        super(orientation, panelHeight, instanceId);
        this._orientation = orientation;
        this._reapplyId = 0;
        this._moved = [];
        this._cells = new Map();
        this._closeSignals = [];

        // No PopupMenuManager on purpose: its modal grab would swallow clicks on the
        // menus the tray icons themselves open. Closing is handled in _connectCloseSignals.
        this.menu = new Applet.AppletPopupMenu(this, orientation);
        this.menu.connect("open-state-changed", (menu, open) => this._onOpenStateChanged(open));

        this._trayBox = new St.BoxLayout({ vertical: false, style_class: "tray-collapse-box" });
        this.menu.box.add_actor(this._trayBox);

        // Other applets may load (or reload) after us; hide them again when the layout changes.
        this._settingsIds = [
            global.settings.connect("changed::enabled-applets", () => { this.menu.close(); this._scheduleReapply(); }),
            global.settings.connect("changed::panel-edit-mode", () => this.menu.close()),
        ];

        this._scheduleReapply();
        this._updateIcon();
    }

    _targets() {
        let result = [];
        for (let uuid of TARGET_UUIDS)
            for (let applet of AppletManager.getRunningInstancesForUuid(uuid))
                if (applet.panel === this.panel && applet._panelLocation)
                    result.push(applet);
        return result;
    }

    _scheduleReapply() {
        if (this._reapplyId)
            GLib.source_remove(this._reapplyId);
        this._reapplyId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => {
            this._reapplyId = 0;
            this._setPanelVisibility(false);
            return GLib.SOURCE_REMOVE;
        });
    }

    _setPanelVisibility(visible) {
        for (let applet of this._targets())
            if (applet.actor.get_parent() === applet._panelLocation)
                applet.actor.visible = visible;
    }

    // Move the target applets from their panel slot into the pop-up.
    _moveIntoPopup() {
        for (let applet of this._targets()) {
            if (applet.actor.get_parent() !== applet._panelLocation)
                continue;
            applet._panelLocation.remove_actor(applet.actor);
            this._trayBox.add_actor(applet.actor);
            applet.actor.visible = true;
            this._moved.push(applet);
        }
        this._decorateCells();
    }

    // Each tray icon is an "applet-box" (the applet itself, or one per icon in xapp-status/systray).
    _findCells(actor, depth = 0) {
        if (actor instanceof St.Widget && actor.has_style_class_name("applet-box"))
            return [actor];
        if (depth >= 3)
            return [];
        return actor.get_children().flatMap(c => this._findCells(c, depth + 1));
    }

    // Give every icon the same square cell with its content centered; undone in _undecorateCells.
    _decorateCells() {
        for (let applet of this._moved) {
            for (let cell of this._findCells(applet.actor)) {
                if (this._cells.has(cell))
                    continue;
                let saved = cell.get_children().map(c => [c, CELL_PROPS.map(prop => c[prop])]);
                for (let [c] of saved) {
                    c.x_expand = c.y_expand = true;
                    // St.Bin aligns its child with its own St.Align-typed x/y_align.
                    if (c instanceof St.Bin) {
                        c.x_align = c.y_align = St.Align.MIDDLE;
                        c.x_fill = c.y_fill = false;
                    } else {
                        c.x_align = c.y_align = Clutter.ActorAlign.CENTER;
                    }
                }
                cell.add_style_class_name("tray-collapse-cell");
                this._cells.set(cell, saved);
            }
        }
    }

    _undecorateCells() {
        for (let [cell, saved] of this._cells) {
            if (cell.is_finalized())
                continue;
            cell.remove_style_class_name("tray-collapse-cell");
            for (let [c, values] of saved)
                if (!c.is_finalized())
                    CELL_PROPS.forEach((prop, i) => { if (values[i] !== undefined) c[prop] = values[i]; });
        }
        this._cells.clear();
    }

    // Put them back where appletManager would have placed them, hidden.
    _restoreToPanel() {
        this._undecorateCells();
        for (let applet of this._moved) {
            if (applet.actor.is_finalized() || applet.actor.get_parent() !== this._trayBox)
                continue;
            this._trayBox.remove_actor(applet.actor);
            let location = applet._panelLocation;
            let before = location.get_children().find(x =>
                x._applet && x._applet instanceof Applet.Applet && applet._order < x._applet._order);
            if (before)
                location.insert_child_below(applet.actor, before);
            else
                location.add_actor(applet.actor);
            applet.actor.visible = false;
        }
        this._moved = [];
    }

    _onOpenStateChanged(open) {
        if (open) {
            // Without a grab, X11 only delivers pointer motion (hover) to areas in Cinnamon's
            // input region. Only tracked while open: hidden tracked actors still block clicks.
            Main.layoutManager.trackChrome(this.menu.actor, { affectsInputRegion: true });
            this._connectCloseSignals();
        } else {
            Main.layoutManager.untrackChrome(this.menu.actor);
            this._disconnectCloseSignals();
            this._restoreToPanel();
        }
        this._updateIcon();
    }

    _isInsideMenuOrSelf(actor) {
        for (let a = actor; a; a = a.get_parent()) {
            if (a === this.actor || a === this.menu.actor)
                return true;
            // Menus opened by the tray icons themselves.
            if (a instanceof St.Widget && a.has_style_class_name("menu"))
                return true;
        }
        return false;
    }

    _connectCloseSignals() {
        this._closeSignals = [
            [global.stage, global.stage.connect("captured-event", (actor, event) => {
                let type = event.type();
                if (type === Clutter.EventType.BUTTON_PRESS && !this._isInsideMenuOrSelf(event.get_source()))
                    this.menu.close();
                else if (type === Clutter.EventType.KEY_PRESS && event.get_key_symbol() === Clutter.KEY_Escape)
                    this.menu.close();
                return Clutter.EVENT_PROPAGATE;
            })],
            // Clicking any window (or the desktop) focuses it; a null focus means a menu took a grab.
            [global.display, global.display.connect("notify::focus-window", () => {
                if (global.display.focus_window)
                    this.menu.close();
            })],
        ];
    }

    _disconnectCloseSignals() {
        for (let [obj, id] of this._closeSignals)
            obj.disconnect(id);
        this._closeSignals = [];
    }

    _updateIcon() {
        let open = this.menu.isOpen;
        let icon;
        switch (this._orientation) {
            case St.Side.BOTTOM: icon = open ? "pan-down-symbolic" : "pan-up-symbolic"; break;
            case St.Side.TOP:    icon = open ? "pan-up-symbolic" : "pan-down-symbolic"; break;
            case St.Side.LEFT:   icon = open ? "pan-start-symbolic" : "pan-end-symbolic"; break;
            default:             icon = open ? "pan-end-symbolic" : "pan-start-symbolic"; break;
        }
        this.set_applet_icon_symbolic_name(icon);
        this.set_applet_tooltip(open ? "" : _("Show hidden icons"));
    }

    on_applet_clicked() {
        if (this.menu.isOpen) {
            this.menu.close();
        } else {
            this._moveIntoPopup();
            this.menu.open();
        }
    }

    on_orientation_changed(orientation) {
        this._orientation = orientation;
        this.menu.close();
        this._updateIcon();
    }

    on_applet_removed_from_panel() {
        this.menu.close();
        if (this._reapplyId)
            GLib.source_remove(this._reapplyId);
        for (let id of this._settingsIds)
            global.settings.disconnect(id);
        this._setPanelVisibility(true);
        this.menu.destroy();
    }
}

function main(metadata, orientation, panelHeight, instanceId) {
    return new TrayCollapseApplet(metadata, orientation, panelHeight, instanceId);
}
