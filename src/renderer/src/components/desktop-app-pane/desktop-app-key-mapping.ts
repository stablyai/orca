import type { DesktopAppInput } from '../../../../shared/desktop-app-types'

export type DesktopAppKeyEvent = Pick<
  KeyboardEvent,
  'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'isComposing'
>

// DOM `key` → the computer-use key grammar (native KeyMap names).
const NAMED_KEYS: Record<string, string> = {
  Enter: 'return',
  Tab: 'tab',
  Backspace: 'backspace',
  Delete: 'forwarddelete',
  Escape: 'escape',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'up',
  ArrowDown: 'down',
  Home: 'home',
  End: 'end',
  PageUp: 'pageup',
  PageDown: 'pagedown',
  ' ': 'space'
}

// Primary-modifier shortcuts the pane forwards; every other ⌘ (Ctrl off Mac) chord stays with
// Orca (new tab, close tab…). V is absent on purpose: the paste event sends the clipboard text.
const FORWARDED_COMMAND_KEYS = new Set(['a', 'c', 'x', 'z', 'f'])

/**
 * Null when the key belongs to Orca or is a bare modifier.
 * Why `isMac`: Orca's own shortcuts sit on ⌘ on a Mac but on Ctrl elsewhere, so the modifier
 * that must be filtered (and the one that means "primary") depends on the host.
 */
export function mapKeyEventToDesktopAppInput(
  event: DesktopAppKeyEvent,
  isMac = true
): DesktopAppInput | null {
  if (event.isComposing || ['Meta', 'Control', 'Alt', 'Shift', 'CapsLock'].includes(event.key)) {
    return null
  }
  return isMac ? mapMacKeyEvent(event) : mapNonMacKeyEvent(event)
}

function mapMacKeyEvent(event: DesktopAppKeyEvent): DesktopAppInput | null {
  const named = NAMED_KEYS[event.key]
  const lower = event.key.length === 1 ? event.key.toLowerCase() : null
  if (event.metaKey) {
    if (!lower || !FORWARDED_COMMAND_KEYS.has(lower) || event.ctrlKey) {
      return null
    }
    return { kind: 'key', key: `${event.shiftKey ? 'shift+' : ''}cmd+${lower}` }
  }
  if (event.ctrlKey || (event.altKey && named)) {
    const base = named ?? lower
    return base ? chord(event, base) : null
  }
  return plainKey(event, named)
}

function mapNonMacKeyEvent(event: DesktopAppKeyEvent): DesktopAppInput | null {
  // Why: the Windows/Super key is owned by the desktop shell, never by the app in the pane.
  if (event.metaKey) {
    return null
  }
  const named = NAMED_KEYS[event.key]
  const lower = event.key.length === 1 ? event.key.toLowerCase() : null
  // Why: AltGr arrives as Ctrl+Alt with the composed character (e.g. "@" on many layouts);
  // it is typing, not a shortcut.
  if (event.ctrlKey && event.altKey && !named && lower && !/[a-z0-9]/.test(lower)) {
    return { kind: 'text', text: event.key }
  }
  if (event.ctrlKey && !named) {
    if (!lower || !FORWARDED_COMMAND_KEYS.has(lower)) {
      return null
    }
    return chord(event, lower)
  }
  // Why: Ctrl+Tab cycles Orca tabs, so it stays with Orca like the Mac ⌘ chords do.
  if (event.ctrlKey && named === 'tab') {
    return null
  }
  const base = named ?? lower
  if (base && (event.ctrlKey || event.altKey)) {
    return chord(event, base)
  }
  return plainKey(event, named)
}

function chord(event: DesktopAppKeyEvent, base: string): DesktopAppInput {
  const modifiers = [
    event.ctrlKey ? 'ctrl' : null,
    event.altKey ? 'alt' : null,
    event.shiftKey ? 'shift' : null
  ].filter(Boolean)
  return { kind: 'key', key: [...modifiers, base].join('+') }
}

function plainKey(event: DesktopAppKeyEvent, named: string | undefined): DesktopAppInput | null {
  if (named) {
    if (named === 'space') {
      return { kind: 'text', text: ' ' }
    }
    return { kind: 'key', key: event.shiftKey ? `shift+${named}` : named }
  }
  // Printable characters (already shifted / option-composed by the OS layout) go as text.
  if ([...event.key].length === 1) {
    return { kind: 'text', text: event.key }
  }
  return null
}
