import type { XtermBypassEvent } from './xterm-bypass-policy'

const TERMINAL_IME_DELETION_RELEASE_GUARD_MS = 1_000

type TerminalImeDeletionKey = 'Backspace' | 'Delete'

export type TerminalImeDeletionReleaseGuard = {
  key?: TerminalImeDeletionKey
  expiresAt: number
}

function resolveTerminalImeDeletionKey(
  event: Pick<XtermBypassEvent, 'key' | 'code'>
): TerminalImeDeletionKey | undefined {
  if (event.code === 'Backspace' || event.code === 'Delete') {
    return event.code
  }
  return event.key === 'Backspace' || event.key === 'Delete' ? event.key : undefined
}

/** Creates one-shot ownership for a Windows IME deletion's paired keyup. */
export function createTerminalImeDeletionReleaseGuard(): TerminalImeDeletionReleaseGuard {
  return { expiresAt: 0 }
}

/** Arms the guard from a tracked composition deletion keydown. */
export function armTerminalImeDeletionReleaseGuard(
  guard: TerminalImeDeletionReleaseGuard,
  event: XtermBypassEvent,
  compositionActive: boolean,
  now: number
): void {
  const key = resolveTerminalImeDeletionKey(event)
  if (event.type === 'keydown' && compositionActive && event.keyCode === 229 && key !== undefined) {
    guard.key = key
    guard.expiresAt = now + TERMINAL_IME_DELETION_RELEASE_GUARD_MS
  }
}

/** Consumes only the ordinary keyup paired with the tracked IME deletion. */
export function consumeTerminalImeDeletionRelease(
  guard: TerminalImeDeletionReleaseGuard,
  event: XtermBypassEvent,
  now: number
): boolean {
  const pendingKey = guard.key
  if (!pendingKey) {
    return false
  }
  if (now > guard.expiresAt) {
    guard.key = undefined
    return false
  }

  const eventKey = resolveTerminalImeDeletionKey(event)
  const isCompositionRelease =
    event.type === 'keyup' &&
    event.keyCode === 229 &&
    (event.key === 'Process' || eventKey === pendingKey) &&
    (event.code === undefined || event.code === '' || event.code === pendingKey)
  if (isCompositionRelease) {
    return false
  }

  const isPairedRelease = event.type === 'keyup' && event.keyCode !== 229 && eventKey === pendingKey
  guard.key = undefined
  return isPairedRelease
}
