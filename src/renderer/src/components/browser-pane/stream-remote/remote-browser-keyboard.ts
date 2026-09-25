type RemoteBrowserKeyboardEvent = {
  key: string
  code?: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
}

export function getRemoteBrowserKeypressKey(event: RemoteBrowserKeyboardEvent): string | null {
  if (event.key.length === 1) {
    return event.key === ' ' ? 'Space' : event.key
  }
  if (event.metaKey || event.ctrlKey || event.altKey) {
    return null
  }
  const supported = new Set([
    'Enter',
    'Backspace',
    'Delete',
    'Tab',
    'Escape',
    'ArrowUp',
    'ArrowDown',
    'ArrowLeft',
    'ArrowRight',
    'Home',
    'End',
    'PageUp',
    'PageDown'
  ])
  return supported.has(event.key) ? event.key : null
}

export function getRemoteBrowserKeyboardShortcut(event: RemoteBrowserKeyboardEvent): string | null {
  const modifiers: string[] = []
  if (event.metaKey) {
    modifiers.push('Meta')
  }
  if (event.ctrlKey) {
    modifiers.push('Control')
  }
  if (event.altKey) {
    modifiers.push('Alt')
  }
  const hasShortcutModifier = event.metaKey || event.ctrlKey || event.altKey
  // Why: Ctrl+Shift+R is a browser shortcut, but plain Shift+R should still
  // flow through as printable text for the remote page.
  if (event.shiftKey && (event.key.length !== 1 || hasShortcutModifier)) {
    modifiers.push('Shift')
  }
  if (modifiers.length === 0 || ['Meta', 'Control', 'Alt', 'Shift'].includes(event.key)) {
    return null
  }
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key
  return `${modifiers.join('+')}+${key}`
}
