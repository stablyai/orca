export type WindowShortcutInput = {
  key?: string
  code?: string
  alt?: boolean
  meta?: boolean
  control?: boolean
  shift?: boolean
}

export type WindowShortcutAction =
  | { type: 'zoom'; direction: 'in' | 'out' | 'reset' }
  | { type: 'toggleWorktreePalette' }
  | { type: 'toggleLeftSidebar' }
  | { type: 'toggleRightSidebar' }
  | { type: 'openQuickOpen' }
  | { type: 'openNewWorkspace' }
  | { type: 'jumpToWorktreeIndex'; index: number }

export function isWindowShortcutModifierChord(
  input: Pick<WindowShortcutInput, 'meta' | 'control' | 'alt'>,
  platform: NodeJS.Platform
): boolean {
  const modifierPressed = platform === 'darwin' ? input.meta : input.control
  return Boolean(modifierPressed) && !input.alt
}

function isZoomInShortcut(input: WindowShortcutInput): boolean {
  return input.key === '=' || input.key === '+' || input.code === 'NumpadAdd'
}

function isZoomOutShortcut(input: WindowShortcutInput): boolean {
  // Why: Electron reports Cmd/Ctrl+Minus differently across layouts and devices:
  // some emit '-' while shifted layouts emit '_', and other layouts/devices
  // report symbolic names like "Minus"/"Subtract" in either key or code.
  // We accept all known variants so zoom out remains reachable everywhere.
  const key = (input.key ?? '').toLowerCase()
  const code = (input.code ?? '').toLowerCase()
  return (
    key === '-' ||
    key === '_' ||
    key.includes('minus') ||
    key.includes('subtract') ||
    code.includes('minus') ||
    code.includes('subtract')
  )
}

export function resolveWindowShortcutAction(
  input: WindowShortcutInput,
  platform: NodeJS.Platform
): WindowShortcutAction | null {
  if (!isWindowShortcutModifierChord(input, platform)) {
    return null
  }

  if (isZoomInShortcut(input)) {
    return { type: 'zoom', direction: 'in' }
  }

  if (isZoomOutShortcut(input)) {
    return { type: 'zoom', direction: 'out' }
  }

  if (input.key === '0' && !input.shift) {
    return { type: 'zoom', direction: 'reset' }
  }

  if (
    input.code === 'KeyJ' &&
    ((platform === 'darwin' && !input.shift) || (platform !== 'darwin' && input.shift))
  ) {
    return { type: 'toggleWorktreePalette' }
  }

  // Why: Ctrl+B and Ctrl+L are terminal control characters (STX / form-feed).
  // Without main-process interception, xterm.js processes the keydown before
  // the renderer's window-capture handler can preventDefault, causing ^B / ^L
  // to appear in the terminal alongside the sidebar toggle.
  if (input.code === 'KeyB' && !input.shift) {
    return { type: 'toggleLeftSidebar' }
  }

  if (input.code === 'KeyL' && !input.shift) {
    return { type: 'toggleRightSidebar' }
  }

  if (input.code === 'KeyP' && !input.shift) {
    return { type: 'openQuickOpen' }
  }

  // Why: Cmd/Ctrl+N opens the new-workspace composer. Routed through the
  // main process so it reaches the renderer even when focus lives inside
  // a contentEditable surface (markdown rich editor) or a browser guest
  // webContents, both of which bypass the renderer's window-level keydown.
  if (input.code === 'KeyN' && !input.shift) {
    return { type: 'openNewWorkspace' }
  }

  if (input.key && input.key >= '1' && input.key <= '9' && !input.shift) {
    return { type: 'jumpToWorktreeIndex', index: parseInt(input.key, 10) - 1 }
  }

  // Why: this helper is the explicit allowlist for main-process interception.
  // Anything not listed here must keep flowing to the renderer/PTTY so readline
  // chords like Ctrl+R, Ctrl+U, and Ctrl+E are not accidentally stolen by a
  // future shortcut addition.
  return null
}
