export function isWindowShortcutModifierChord(input, platform) {
    const modifierPressed = platform === 'darwin' ? input.meta : input.control;
    return Boolean(modifierPressed) && !input.alt;
}
function isZoomInShortcut(input) {
    return input.key === '=' || input.key === '+' || input.code === 'NumpadAdd';
}
function isZoomOutShortcut(input) {
    // Why: Electron reports Cmd/Ctrl+Minus differently across layouts and devices:
    // some emit '-' while shifted layouts emit '_', and other layouts/devices
    // report symbolic names like "Minus"/"Subtract" in either key or code.
    // We accept all known variants so zoom out remains reachable everywhere.
    const key = (input.key ?? '').toLowerCase();
    const code = (input.code ?? '').toLowerCase();
    return (key === '-' ||
        key === '_' ||
        key.includes('minus') ||
        key.includes('subtract') ||
        code.includes('minus') ||
        code.includes('subtract'));
}
export function resolveWindowShortcutAction(input, platform) {
    if (!isWindowShortcutModifierChord(input, platform)) {
        return null;
    }
    if (isZoomInShortcut(input)) {
        return { type: 'zoom', direction: 'in' };
    }
    if (isZoomOutShortcut(input)) {
        return { type: 'zoom', direction: 'out' };
    }
    if (input.key === '0' && !input.shift) {
        return { type: 'zoom', direction: 'reset' };
    }
    if (input.code === 'KeyJ' &&
        ((platform === 'darwin' && !input.shift) || (platform !== 'darwin' && input.shift))) {
        return { type: 'toggleWorktreePalette' };
    }
    // Why: Ctrl+B and Ctrl+L are terminal control characters (STX / form-feed).
    // Without main-process interception, xterm.js processes the keydown before
    // the renderer's window-capture handler can preventDefault, causing ^B / ^L
    // to appear in the terminal alongside the sidebar toggle.
    if (input.code === 'KeyB' && !input.shift) {
        return { type: 'toggleLeftSidebar' };
    }
    if (input.code === 'KeyL' && !input.shift) {
        return { type: 'toggleRightSidebar' };
    }
    if (input.code === 'KeyP' && !input.shift) {
        return { type: 'openQuickOpen' };
    }
    if (input.key && input.key >= '1' && input.key <= '9' && !input.shift) {
        return { type: 'jumpToWorktreeIndex', index: parseInt(input.key, 10) - 1 };
    }
    // Why: this helper is the explicit allowlist for main-process interception.
    // Anything not listed here must keep flowing to the renderer/PTTY so readline
    // chords like Ctrl+R, Ctrl+U, and Ctrl+E are not accidentally stolen by a
    // future shortcut addition.
    return null;
}
