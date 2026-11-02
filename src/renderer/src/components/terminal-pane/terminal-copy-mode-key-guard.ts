const claimed = new Map<string, () => boolean>()
let listening = false
let users = 0

export function consumeCopyModeEvent(event: Event): void {
  event.preventDefault()
  event.stopImmediatePropagation()
}

function keyIdentity(event: KeyboardEvent): string {
  return event.code || event.key
}

function clear(): void {
  claimed.clear()
  if (users > 0) {
    return
  }
  listening = false
  window.removeEventListener('keydown', onKeyDown, true)
  window.removeEventListener('keypress', onKeyPress, true)
  window.removeEventListener('keyup', onKeyUp, true)
  window.removeEventListener('blur', clear)
}

function onKeyDown(event: KeyboardEvent): void {
  const identity = keyIdentity(event)
  // macOS may omit a Command chord's keyup; a fresh press supersedes only that key.
  if (!event.repeat) {
    if (claimed.delete(identity) && claimed.size === 0) {
      clear()
    }
    return
  }
  const mayRepeat = claimed.get(identity)
  if (mayRepeat && !mayRepeat()) {
    consumeCopyModeEvent(event)
  }
}

function onKeyPress(event: KeyboardEvent): void {
  if (claimed.has(keyIdentity(event))) {
    consumeCopyModeEvent(event)
  }
}

function onKeyUp(event: KeyboardEvent): void {
  if (!claimed.delete(keyIdentity(event))) {
    return
  }
  consumeCopyModeEvent(event)
  if (claimed.size === 0) {
    clear()
  }
}

// Install before terminal capture handlers; key tails may outlive their pane.
export function installCopyModeKeyGuard(): () => void {
  users += 1
  if (!listening) {
    listening = true
    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('keypress', onKeyPress, true)
    window.addEventListener('keyup', onKeyUp, true)
    window.addEventListener('blur', clear)
  }
  return () => {
    users -= 1
    if (users === 0 && claimed.size === 0) {
      clear()
    }
  }
}

export function claimCopyModeKey(event: KeyboardEvent, mayRepeat: () => boolean): void {
  claimed.set(keyIdentity(event), mayRepeat)
}
