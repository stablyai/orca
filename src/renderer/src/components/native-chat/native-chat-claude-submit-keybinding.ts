// Deterministically resolve the gesture the user bound to `chat:submit` in their
// Claude Code keybindings.json. Two consumers project it differently: the native
// chat writes a coding agent's TUI over a pty and needs the submit *bytes*; the
// file-comment editor is a DOM textarea and needs to know which *keystroke*
// submits. Both must honour a user who remapped Enter to insert a newline rather
// than assume Enter submits. Unknown/unreadable config falls back to Enter,
// Claude's default submit.

const CHAT_CONTEXT = 'Chat'
const SUBMIT_ACTION = 'chat:submit'

/** Carriage return: plain Enter, Claude's default submit. */
export const CLAUDE_SUBMIT_ENTER = '\r'
/** ESC+CR: Alt/Meta+Enter (the legacy meta prefix macOS Option also sends). */
export const CLAUDE_SUBMIT_ALT_ENTER = '\x1b\r'
/** Line feed: Ctrl+J, Claude's default `chat:newline` key, also bindable to submit. */
export const CLAUDE_SUBMIT_CTRL_J = '\n'

export type ClaudeSubmitGesture = 'enter' | 'alt-enter' | 'ctrl-j'

/** Gesture for a single keystroke spec, or null when it needs a modifier the pty
 *  can't carry without the kitty protocol (Cmd/Super/Ctrl+Enter). */
function submitGestureForKeystroke(keystroke: string): ClaudeSubmitGesture | null {
  const parts = keystroke
    .toLowerCase()
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean)
  if (parts.length === 0) {
    return null
  }
  const key = parts.at(-1)!
  const modifiers = new Set(parts.slice(0, -1))
  if (key === 'enter' || key === 'return') {
    if (modifiers.size === 0) {
      return 'enter'
    }
    if (
      modifiers.has('meta') ||
      modifiers.has('alt') ||
      modifiers.has('opt') ||
      modifiers.has('option')
    ) {
      return 'alt-enter'
    }
    return null
  }
  if (key === 'j' && modifiers.has('ctrl')) {
    return 'ctrl-j'
  }
  return null
}

function collectChatSubmitKeystrokes(parsed: unknown): string[] {
  const bindings =
    typeof parsed === 'object' && parsed !== null
      ? (parsed as { bindings?: unknown }).bindings
      : undefined
  if (!Array.isArray(bindings)) {
    return []
  }
  const keystrokes: string[] = []
  for (const entry of bindings) {
    if (typeof entry !== 'object' || entry === null) {
      continue
    }
    if ((entry as { context?: unknown }).context !== CHAT_CONTEXT) {
      continue
    }
    const map = (entry as { bindings?: unknown }).bindings
    if (typeof map !== 'object' || map === null) {
      continue
    }
    for (const [keystroke, action] of Object.entries(map)) {
      if (action === SUBMIT_ACTION) {
        keystrokes.push(keystroke)
      }
    }
  }
  return keystrokes
}

export function claudeSubmitBytesForGesture(gesture: ClaudeSubmitGesture): string {
  switch (gesture) {
    case 'enter':
      return CLAUDE_SUBMIT_ENTER
    case 'alt-enter':
      return CLAUDE_SUBMIT_ALT_ENTER
    case 'ctrl-j':
      return CLAUDE_SUBMIT_CTRL_J
  }
}

export function resolveClaudeSubmitGesture(
  keybindingsJson: string | null | undefined
): ClaudeSubmitGesture {
  if (!keybindingsJson) {
    return 'enter'
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(keybindingsJson)
  } catch {
    return 'enter'
  }
  const gestures = collectChatSubmitKeystrokes(parsed)
    .map(submitGestureForKeystroke)
    .filter((gesture): gesture is ClaudeSubmitGesture => gesture !== null)
  // Prefer the most robust gesture: plain Enter, then Alt+Enter, then Ctrl+J. A
  // submit bound only to Cmd/Super+Enter isn't pty-representable, so we fall
  // through to Enter (the default) rather than resolve to nothing.
  if (gestures.includes('enter')) {
    return 'enter'
  }
  if (gestures.includes('alt-enter')) {
    return 'alt-enter'
  }
  if (gestures.includes('ctrl-j')) {
    return 'ctrl-j'
  }
  return 'enter'
}

export function resolveClaudeSubmitBytes(keybindingsJson: string | null | undefined): string {
  return claudeSubmitBytesForGesture(resolveClaudeSubmitGesture(keybindingsJson))
}

/** Whether a DOM keydown is the resolved submit gesture. `'enter'` keeps the
 *  prior behavior (any Enter but Shift+Enter submits); once submit is bound off
 *  Enter, a bare Enter is a newline and only the bound modifier submits. */
export function claudeSubmitGestureMatchesKeyboardEvent(
  gesture: ClaudeSubmitGesture,
  event: { key: string; altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }
): boolean {
  if (gesture === 'ctrl-j') {
    return (event.key === 'j' || event.key === 'J') && event.ctrlKey
  }
  if (event.key !== 'Enter') {
    return false
  }
  if (gesture === 'enter') {
    return !event.shiftKey
  }
  return event.altKey || event.metaKey
}
