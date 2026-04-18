export const EMPTY_LAYOUT = {
    root: null,
    activeLeafId: null,
    expandedLeafId: null
};
export function paneLeafId(paneId) {
    return `pane:${paneId}`;
}
export function collectLeafIdsInOrder(node) {
    if (!node) {
        return [];
    }
    if (node.type === 'leaf') {
        return [node.leafId];
    }
    return [...collectLeafIdsInOrder(node.first), ...collectLeafIdsInOrder(node.second)];
}
function getLeftmostLeafId(node) {
    return node.type === 'leaf' ? node.leafId : getLeftmostLeafId(node.first);
}
function collectReplayCreatedPaneLeafIds(node, leafIdsInReplayCreationOrder) {
    // Why: replayTerminalLayout() creates one new pane per split and assigns it
    // to the split's second subtree before recursing, so the new pane maps to
    // the leftmost leaf reachable within that second subtree.
    leafIdsInReplayCreationOrder.push(getLeftmostLeafId(node.second));
    if (node.first.type === 'split') {
        collectReplayCreatedPaneLeafIds(node.first, leafIdsInReplayCreationOrder);
    }
    if (node.second.type === 'split') {
        collectReplayCreatedPaneLeafIds(node.second, leafIdsInReplayCreationOrder);
    }
}
export function collectLeafIdsInReplayCreationOrder(node) {
    if (!node) {
        return [];
    }
    const leafIdsInReplayCreationOrder = [getLeftmostLeafId(node)];
    if (node.type === 'split') {
        collectReplayCreatedPaneLeafIds(node, leafIdsInReplayCreationOrder);
    }
    return leafIdsInReplayCreationOrder;
}
// Cross-platform monospace fallback chain ensures the terminal always has a
// usable font regardless of OS.  macOS-only fonts like SF Mono and Menlo are
// harmless on other platforms (the browser skips them), while Cascadia Mono /
// Consolas cover Windows and DejaVu Sans Mono / Liberation Mono cover Linux.
const FALLBACK_FONTS = [
    'SF Mono', // macOS 10.12+
    'Menlo', // macOS (older)
    'Monaco', // macOS (legacy)
    'Cascadia Mono', // Windows 11+
    'Consolas', // Windows Vista+
    'DejaVu Sans Mono', // Linux (common)
    'Liberation Mono', // Linux (common)
    'monospace' // ultimate generic fallback
];
export function buildFontFamily(fontFamily) {
    const trimmed = fontFamily.trim();
    const parts = trimmed ? [`"${trimmed}"`] : [];
    const lowerParts = parts.map((p) => p.toLowerCase());
    // Append each fallback unless the user's font name already contains it
    // (case-insensitive) to avoid duplicates like '"SF Mono", "SF Mono"'.
    for (const fallback of FALLBACK_FONTS) {
        const lower = fallback.toLowerCase();
        if (!lowerParts.some((p) => p.includes(lower))) {
            // Generic keywords like "monospace" are unquoted; named fonts are quoted.
            parts.push(fallback === 'monospace' ? fallback : `"${fallback}"`);
        }
    }
    return parts.join(', ');
}
export function getLayoutChildNodes(split) {
    return Array.from(split.children).filter((child) => child instanceof HTMLElement &&
        (child.classList.contains('pane') || child.classList.contains('pane-split')));
}
export function serializePaneTree(node) {
    if (!node) {
        return null;
    }
    if (node.classList.contains('pane')) {
        const paneId = Number(node.dataset.paneId ?? '');
        if (!Number.isFinite(paneId)) {
            return null;
        }
        return { type: 'leaf', leafId: paneLeafId(paneId) };
    }
    if (!node.classList.contains('pane-split')) {
        return null;
    }
    const [first, second] = getLayoutChildNodes(node);
    const firstNode = serializePaneTree(first ?? null);
    const secondNode = serializePaneTree(second ?? null);
    if (!firstNode || !secondNode) {
        return null;
    }
    // Capture the flex ratio so resized panes survive serialization round-trips.
    // We read the computed flex-grow values to derive the first-child proportion.
    let ratio;
    if (first && second) {
        const firstGrow = parseFloat(first.style.flex) || 1;
        const secondGrow = parseFloat(second.style.flex) || 1;
        const total = firstGrow + secondGrow;
        if (total > 0) {
            const r = firstGrow / total;
            // Only store if meaningfully different from 0.5 (default equal split)
            if (Math.abs(r - 0.5) > 0.005) {
                ratio = Math.round(r * 1000) / 1000;
            }
        }
    }
    return {
        type: 'split',
        direction: node.classList.contains('is-horizontal') ? 'horizontal' : 'vertical',
        first: firstNode,
        second: secondNode,
        ...(ratio !== undefined && { ratio })
    };
}
export function serializeTerminalLayout(root, activePaneId, expandedPaneId) {
    const rootNode = serializePaneTree(root?.firstElementChild instanceof HTMLElement ? root.firstElementChild : null);
    return {
        root: rootNode,
        activeLeafId: activePaneId === null ? null : paneLeafId(activePaneId),
        expandedLeafId: expandedPaneId === null ? null : paneLeafId(expandedPaneId)
    };
}
function collectLeafIds(node, paneByLeafId, paneId) {
    if (node.type === 'leaf') {
        paneByLeafId.set(node.leafId, paneId);
        return;
    }
    collectLeafIds(node.first, paneByLeafId, paneId);
    collectLeafIds(node.second, paneByLeafId, paneId);
}
/**
 * Write saved scrollback buffers into the restored panes so the user sees
 * their previous terminal output after an app restart.  If a buffer was
 * captured while the alternate screen was active (e.g. an agent TUI was
 * running at shutdown), we exit alt-screen first so the user sees a usable
 * normal-mode terminal.
 */
export function restoreScrollbackBuffers(manager, savedBuffers, restoredPaneByLeafId) {
    if (!savedBuffers) {
        return;
    }
    const ALT_SCREEN_ON = '\x1b[?1049h';
    const ALT_SCREEN_OFF = '\x1b[?1049l';
    for (const [oldLeafId, buffer] of Object.entries(savedBuffers)) {
        const newPaneId = restoredPaneByLeafId.get(oldLeafId);
        if (newPaneId == null || !buffer) {
            continue;
        }
        const pane = manager.getPanes().find((p) => p.id === newPaneId);
        if (!pane) {
            continue;
        }
        try {
            let buf = buffer;
            // If buffer ends in alt-screen mode (agent TUI was running at
            // shutdown), exit alt-screen so the user sees a usable terminal.
            const lastOn = buf.lastIndexOf(ALT_SCREEN_ON);
            const lastOff = buf.lastIndexOf(ALT_SCREEN_OFF);
            if (lastOn > lastOff) {
                buf = buf.slice(0, lastOn);
            }
            if (buf.length > 0) {
                pane.terminal.write(buf);
                // Ensure cursor is on a new line so the new shell prompt
                // doesn't trigger zsh's PROMPT_EOL_MARK (%) indicator.
                pane.terminal.write('\r\n');
            }
        }
        catch {
            // If restore fails, continue with blank terminal.
        }
    }
}
export function replayTerminalLayout(manager, snapshot, focusInitialPane) {
    const paneByLeafId = new Map();
    const initialPane = manager.createInitialPane({ focus: focusInitialPane });
    if (!snapshot?.root) {
        paneByLeafId.set(paneLeafId(initialPane.id), initialPane.id);
        return paneByLeafId;
    }
    const restoreNode = (node, paneId) => {
        if (node.type === 'leaf') {
            paneByLeafId.set(node.leafId, paneId);
            return;
        }
        const createdPane = manager.splitPane(paneId, node.direction, {
            ratio: node.ratio
        });
        if (!createdPane) {
            collectLeafIds(node, paneByLeafId, paneId);
            return;
        }
        restoreNode(node.first, paneId);
        restoreNode(node.second, createdPane.id);
    };
    restoreNode(snapshot.root, initialPane.id);
    return paneByLeafId;
}
