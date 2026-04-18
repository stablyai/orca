export function fitPanes(manager) {
    for (const pane of manager.getPanes()) {
        try {
            // Why: fitAddon.fit() calls _renderService.clear() + terminal.refresh()
            // even when dimensions haven't changed (the patched FitAddon only skips
            // terminal.resize()).  On Windows the clear+refresh overhead is non-trivial
            // with 10 000 scrollback lines.  Skip entirely when the proposed dimensions
            // match the current ones — this is the common case when a terminal simply
            // transitions from hidden → visible at the same container size.
            const dims = pane.fitAddon.proposeDimensions();
            if (dims && dims.cols === pane.terminal.cols && dims.rows === pane.terminal.rows) {
                continue;
            }
            const buf = pane.terminal.buffer.active;
            const wasAtBottom = buf.viewportY >= buf.baseY;
            pane.fitAddon.fit();
            if (wasAtBottom) {
                pane.terminal.scrollToBottom();
            }
        }
        catch {
            /* ignore */
        }
    }
}
/**
 * Returns true if any pane's proposed dimensions differ from its current
 * terminal cols/rows, meaning a fit() call would actually change layout.
 * Used by the epoch-based deduplication in use-terminal-pane-global-effects
 * to allow legitimate resize fits while suppressing redundant ones.
 */
export function hasDimensionsChanged(manager) {
    for (const pane of manager.getPanes()) {
        try {
            const dims = pane.fitAddon.proposeDimensions();
            if (!dims) {
                return true; // can't determine — assume changed
            }
            if (dims.cols !== pane.terminal.cols || dims.rows !== pane.terminal.rows) {
                return true;
            }
        }
        catch {
            return true;
        }
    }
    return false;
}
export function focusActivePane(manager) {
    const panes = manager.getPanes();
    const activePane = manager.getActivePane() ?? panes[0];
    activePane?.terminal.focus();
}
export function fitAndFocusPanes(manager) {
    fitPanes(manager);
    focusActivePane(manager);
}
export function isWindowsUserAgent(userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent) {
    return userAgent.includes('Windows');
}
export function isMacUserAgent(userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent) {
    return userAgent.includes('Mac');
}
export function shellEscapePath(path, userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent) {
    if (isWindowsUserAgent(userAgent)) {
        return /^[a-zA-Z0-9_./@:\\-]+$/.test(path) ? path : `"${path}"`;
    }
    if (/^[a-zA-Z0-9_./@:-]+$/.test(path)) {
        return path;
    }
    return `'${path.replace(/'/g, "'\\''")}'`;
}
