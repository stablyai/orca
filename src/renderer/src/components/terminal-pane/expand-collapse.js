function rememberPaneStyle(snapshots, el) {
    if (snapshots.has(el)) {
        return;
    }
    snapshots.set(el, { display: el.style.display, flex: el.style.flex });
}
export function restoreExpandedLayoutFrom(snapshots) {
    for (const [el, prev] of snapshots.entries()) {
        el.style.display = prev.display;
        el.style.flex = prev.flex;
    }
    snapshots.clear();
}
export function applyExpandedLayoutTo(paneId, state) {
    const manager = state.managerRef.current;
    const root = state.containerRef.current;
    if (!manager || !root) {
        return false;
    }
    const panes = manager.getPanes();
    if (panes.length <= 1) {
        return false;
    }
    const targetPane = panes.find((pane) => pane.id === paneId);
    if (!targetPane) {
        return false;
    }
    restoreExpandedLayoutFrom(state.expandedStyleSnapshotRef.current);
    const snapshots = state.expandedStyleSnapshotRef.current;
    let current = targetPane.container;
    while (current && current !== root) {
        const parent = current.parentElement;
        if (!parent) {
            break;
        }
        for (const child of Array.from(parent.children)) {
            if (!(child instanceof HTMLElement)) {
                continue;
            }
            rememberPaneStyle(snapshots, child);
            if (child === current) {
                // Only update flex — do NOT reset display to '' because split
                // containers rely on inline `display: flex` (no CSS class rule
                // exists for it). Clearing it collapses the flex context, which
                // prevents FitAddon from measuring the expanded dimensions.
                child.style.flex = '1 1 auto';
            }
            else {
                child.style.display = 'none';
            }
        }
        current = parent;
    }
    return true;
}
export function createExpandCollapseActions(state) {
    const setExpandedPane = (paneId) => {
        state.expandedPaneIdRef.current = paneId;
        state.setExpandedPaneId(paneId);
        state.setTabPaneExpanded(state.tabId, paneId !== null);
        state.persistLayoutSnapshot();
    };
    const restoreExpandedLayout = () => {
        restoreExpandedLayoutFrom(state.expandedStyleSnapshotRef.current);
    };
    const refreshPaneSizes = (focusActive) => {
        requestAnimationFrame(() => {
            const manager = state.managerRef.current;
            if (!manager) {
                return;
            }
            const panes = manager.getPanes();
            for (const p of panes) {
                try {
                    const buf = p.terminal.buffer.active;
                    const wasAtBottom = buf.viewportY >= buf.baseY;
                    p.fitAddon.fit();
                    if (wasAtBottom) {
                        p.terminal.scrollToBottom();
                    }
                }
                catch {
                    /* container may not have dimensions */
                }
            }
            if (focusActive) {
                const active = manager.getActivePane() ?? panes[0];
                active?.terminal.focus();
            }
        });
    };
    const syncExpandedLayout = () => {
        const paneId = state.expandedPaneIdRef.current;
        if (paneId === null) {
            restoreExpandedLayout();
            return;
        }
        const manager = state.managerRef.current;
        if (!manager) {
            return;
        }
        const panes = manager.getPanes();
        if (panes.length <= 1 || !panes.some((pane) => pane.id === paneId)) {
            setExpandedPane(null);
            restoreExpandedLayout();
            return;
        }
        applyExpandedLayoutTo(paneId, state);
    };
    const toggleExpandPane = (paneId) => {
        const manager = state.managerRef.current;
        if (!manager) {
            return;
        }
        const panes = manager.getPanes();
        if (panes.length <= 1) {
            return;
        }
        const isAlreadyExpanded = state.expandedPaneIdRef.current === paneId;
        if (isAlreadyExpanded) {
            setExpandedPane(null);
            restoreExpandedLayout();
            refreshPaneSizes(true);
            state.persistLayoutSnapshot();
            return;
        }
        setExpandedPane(paneId);
        if (!applyExpandedLayoutTo(paneId, state)) {
            setExpandedPane(null);
            restoreExpandedLayout();
            state.persistLayoutSnapshot();
            return;
        }
        manager.setActivePane(paneId, { focus: true });
        refreshPaneSizes(true);
        state.persistLayoutSnapshot();
    };
    return {
        setExpandedPane,
        restoreExpandedLayout,
        refreshPaneSizes,
        syncExpandedLayout,
        toggleExpandPane
    };
}
