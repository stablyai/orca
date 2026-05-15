export type WindowShortcutInput = {
  type?: string
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
  | { type: 'toggleFloatingTerminal' }
  | { type: 'toggleLeftSidebar' }
  | { type: 'toggleRightSidebar' }
  | { type: 'openQuickOpen' }
  | { type: 'openNewWorkspace' }
  | { type: 'jumpToWorktreeIndex'; index: number }
  | { type: 'worktreeHistoryNavigate'; direction: 'back' | 'forward' }
  | { type: 'dictationKeyDown' }

function platformPrimaryModifier(
  input: Pick<WindowShortcutInput, 'meta' | 'control'>,
  platform: NodeJS.Platform
): boolean {
  return platform === 'darwin' ? Boolean(input.meta) : Boolean(input.control)
}

function platformOppositeModifier(
  input: Pick<WindowShortcutInput, 'meta' | 'control'>,
  platform: NodeJS.Platform
): boolean {
  return platform === 'darwin' ? Boolean(input.control) : Boolean(input.meta)
}

export function isWindowShortcutModifierChord(
  input: Pick<WindowShortcutInput, 'meta' | 'control' | 'alt'>,
  platform: NodeJS.Platform
): boolean {
  return platformPrimaryModifier(input, platform) && !input.alt
}

// Why: worktree history navigation is the first allowlisted chord that
// intentionally carries Alt, so it needs its own predicate. The shared
// isWindowShortcutModifierChord helper deliberately rejects Alt because its
// callers (zoom, sidebar toggles, palette, jump indices) must not steal
// Alt-combinations used by shells and readline.
//
// Why: this predicate also narrows to ArrowLeft/ArrowRight (not just
// "primary+alt") so a future alt-carrying chord added as its own branch in
// resolveWindowShortcutAction is not silently swallowed by the early
// return-null below. Any non-arrow alt combo falls through to the rest of
// the policy, where Alt is rejected by isWindowShortcutModifierChord as
// before.
function isHistoryNavigateChord(input: WindowShortcutInput, platform: NodeJS.Platform): boolean {
  // Why: excluding Shift reserves Cmd/Ctrl+Alt+Shift+Arrow for future chords
  // (e.g. "close back/forward entry" or cross-stack selection) without
  // taking a breaking-change hit on the v1 chord binding. Excluding the
  // opposite primary modifier (Ctrl on darwin, Meta on non-darwin) prevents
  // Cmd+Ctrl+Alt+Arrow / Win+Ctrl+Alt+Arrow from being mis-classified as
  // history navigation — those combinations collide with OS chords
  // (macOS Mission Control spaces, GNOME workspace switching) and must
  // continue to flow to the OS.
  return (
    platformPrimaryModifier(input, platform) &&
    !platformOppositeModifier(input, platform) &&
    Boolean(input.alt) &&
    !input.shift &&
    (input.code === 'ArrowLeft' || input.code === 'ArrowRight')
  )
}

function isFloatingTerminalChord(input: WindowShortcutInput, platform: NodeJS.Platform): boolean {
  return (
    platformPrimaryModifier(input, platform) &&
    !platformOppositeModifier(input, platform) &&
    Boolean(input.alt) &&
    !input.shift &&
    matchesLetterShortcut(input, 't', 'KeyT')
  )
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

// Why: letter shortcuts must follow the user's active keyboard layout. Matching
// solely on `input.code` uses the physical QWERTY position of the key, which
// breaks on Dvorak, Colemak, AZERTY, and other non-QWERTY layouts — e.g. on
// Dvorak the key that types 'b' sits at physical position 'KeyN', so
// `input.code === 'KeyB'` never fires when the user presses what is, to them,
// "Cmd+B". `input.key` carries the layout-aware character, so we prefer it
// when it looks like a letter. We fall back to the QWERTY code when `key` is
// empty or non-letter (dead keys, some IME states, rare Electron edge cases)
// so shortcuts still reach users whose driver does not surface `key`.
function matchesLetterShortcut(
  input: WindowShortcutInput,
  letter: string,
  codeFallback: string
): boolean {
  const key = (input.key ?? '').toLowerCase()
  if (key.length === 1 && key >= 'a' && key <= 'z') {
    return key === letter
  }
  return input.code === codeFallback
}

export function resolveWindowShortcutAction(
  input: WindowShortcutInput,
  platform: NodeJS.Platform
): WindowShortcutAction | null {
  // Why: evaluate the history-navigate chord BEFORE the standard modifier-chord
  // gate because that gate rejects Alt. The predicate already narrows to
  // ArrowLeft/ArrowRight so only those two codes reach here.
  if (isHistoryNavigateChord(input, platform)) {
    return {
      type: 'worktreeHistoryNavigate',
      direction: input.code === 'ArrowLeft' ? 'back' : 'forward'
    }
  }

  if (isFloatingTerminalChord(input, platform)) {
    return { type: 'toggleFloatingTerminal' }
  }

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
    matchesLetterShortcut(input, 'j', 'KeyJ') &&
    ((platform === 'darwin' && !input.shift) || (platform !== 'darwin' && input.shift))
  ) {
    return { type: 'toggleWorktreePalette' }
  }

  // Why: Ctrl+B and Ctrl+L are terminal control characters (STX / form-feed).
  // Without main-process interception, xterm.js processes the keydown before
  // the renderer's window-capture handler can preventDefault, causing ^B / ^L
  // to appear in the terminal alongside the sidebar toggle.
  if (matchesLetterShortcut(input, 'b', 'KeyB') && !input.shift) {
    return { type: 'toggleLeftSidebar' }
  }

  if (matchesLetterShortcut(input, 'l', 'KeyL') && !input.shift) {
    return { type: 'toggleRightSidebar' }
  }

  if (matchesLetterShortcut(input, 'p', 'KeyP') && !input.shift) {
    return { type: 'openQuickOpen' }
  }

  // Why: Cmd/Ctrl+N opens the new-workspace composer. Routed through the
  // main process so it reaches the renderer even when focus lives inside
  // a contentEditable surface (markdown rich editor) or a browser guest
  // webContents, both of which bypass the renderer's window-level keydown.
  // Shift is accepted for compatibility with the former Create-from shortcut;
  // the unified composer now exposes source switching inside the name field.
  if (matchesLetterShortcut(input, 'n', 'KeyN')) {
    if (!input.alt) {
      return { type: 'openNewWorkspace' }
    }
  }

  // Why: Cmd/Ctrl+E activates voice dictation. Routed through the main process
  // (same rationale as the other shortcuts in this allowlist) so the keydown
  // reaches the renderer's dictation controller even when focus is inside a
  // contentEditable surface or browser guest webContents. Acknowledged
  // tradeoff: this preempts Ctrl+E (readline end-of-line) inside the terminal
  // on Linux/Windows when the global window matches first. The renderer's
  // dictation controller is responsible for forwarding the chord through to
  // the PTY when dictation is intentionally disabled or the user is mid-input.
  if (matchesLetterShortcut(input, 'e', 'KeyE') && !input.shift) {
    return { type: 'dictationKeyDown' }
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
