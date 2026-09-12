import { useSyncExternalStore } from 'react'

// How long the popup stays up from the last copy, matching herdr's CopyFeedback deadline.
export const TERMINAL_COPY_FLASH_VISIBLE_MS = 2_000
// Selection changes stop at mouse release; the copy-on-select popup waits out this quiet
// window so a drag shows one popup at the end, never one per character.
export const TERMINAL_COPY_FLASH_DRAG_QUIET_MS = 200

type TerminalCopyFlashEntry = {
  visible: boolean
  quietTimer: number | undefined
  hideTimer: number | undefined
}

const flashesByPaneId = new Map<number, TerminalCopyFlashEntry>()
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) {
    listener()
  }
}

function show(entry: TerminalCopyFlashEntry): void {
  if (entry.hideTimer !== undefined) {
    window.clearTimeout(entry.hideTimer)
  }
  entry.visible = true
  emit()
  entry.hideTimer = window.setTimeout(() => {
    entry.hideTimer = undefined
    entry.visible = false
    emit()
  }, TERMINAL_COPY_FLASH_VISIBLE_MS)
}

function requestFlash(paneId: number, mode: 'immediate' | 'after-drag-quiet'): void {
  let entry = flashesByPaneId.get(paneId)
  if (!entry) {
    entry = { visible: false, quietTimer: undefined, hideTimer: undefined }
    flashesByPaneId.set(paneId, entry)
  }
  if (mode === 'after-drag-quiet') {
    if (entry.quietTimer !== undefined) {
      window.clearTimeout(entry.quietTimer)
    }
    entry.quietTimer = window.setTimeout(() => {
      entry.quietTimer = undefined
      show(entry)
    }, TERMINAL_COPY_FLASH_DRAG_QUIET_MS)
    return
  }
  if (entry.quietTimer !== undefined) {
    window.clearTimeout(entry.quietTimer)
    entry.quietTimer = undefined
  }
  show(entry)
}

/** Shows the popup now, restarting the 2s window. Discrete copies (Cmd+C) use this. */
export function notifyTerminalCopyFlash(paneId: number): void {
  requestFlash(paneId, 'immediate')
}

/** Arms the popup to appear once selection changes go quiet (drag released). */
export function notifyTerminalSelectionCopyFlash(paneId: number): void {
  requestFlash(paneId, 'after-drag-quiet')
}

/** Cancels timers and drops state for panes that no longer exist. */
export function pruneTerminalCopyFlashPaneIds(paneIds: ReadonlySet<number>): void {
  let pruned = false
  for (const [paneId, entry] of flashesByPaneId) {
    if (!paneIds.has(paneId)) {
      if (entry.quietTimer !== undefined) {
        window.clearTimeout(entry.quietTimer)
      }
      if (entry.hideTimer !== undefined) {
        window.clearTimeout(entry.hideTimer)
      }
      flashesByPaneId.delete(paneId)
      pruned = true
    }
  }
  if (pruned) {
    emit()
  }
}

export function subscribeTerminalCopyFlash(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function isTerminalCopyFlashVisible(paneId: number): boolean {
  return flashesByPaneId.get(paneId)?.visible ?? false
}

export function useTerminalCopyFlash(paneId: number): boolean {
  return useSyncExternalStore(
    subscribeTerminalCopyFlash,
    () => isTerminalCopyFlashVisible(paneId),
    () => false
  )
}
