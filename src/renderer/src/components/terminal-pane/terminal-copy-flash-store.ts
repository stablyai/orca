import { useSyncExternalStore } from 'react'
import type { TerminalLeafId } from '../../../../shared/stable-pane-id'

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

// Keyed by the pane's durable leafId, not its numeric id: multiple PaneManagers mount
// concurrently (e.g. every worktree terminal surface plus the floating terminal panel), and
// their numeric pane ids are only unique within one manager, not globally.
const flashesByLeafId = new Map<TerminalLeafId, TerminalCopyFlashEntry>()
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

/** Shows or restarts the flash for one pane's entry, immediately or after a drag-quiet delay. */
function requestFlash(leafId: TerminalLeafId, mode: 'immediate' | 'after-drag-quiet'): void {
  let entry = flashesByLeafId.get(leafId)
  if (!entry) {
    entry = { visible: false, quietTimer: undefined, hideTimer: undefined }
    flashesByLeafId.set(leafId, entry)
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
export function notifyTerminalCopyFlash(leafId: TerminalLeafId): void {
  requestFlash(leafId, 'immediate')
}

/** Arms the popup to appear once selection changes go quiet (drag released). */
export function notifyTerminalSelectionCopyFlash(leafId: TerminalLeafId): void {
  requestFlash(leafId, 'after-drag-quiet')
}

/** Cancels timers and drops state for exactly the given leafIds (panes this caller's own
 *  surface used to manage and no longer does). Callers MUST NOT pass "keep only these" style
 *  full snapshots: the map is shared across every concurrently mounted PaneManager surface, so
 *  deleting anything absent from one surface's own pane list would also wipe out flash state
 *  that legitimately belongs to a different, still-live surface. */
export function pruneTerminalCopyFlashLeafIds(leafIds: ReadonlySet<TerminalLeafId>): void {
  let pruned = false
  for (const leafId of leafIds) {
    const entry = flashesByLeafId.get(leafId)
    if (!entry) {
      continue
    }
    if (entry.quietTimer !== undefined) {
      window.clearTimeout(entry.quietTimer)
    }
    if (entry.hideTimer !== undefined) {
      window.clearTimeout(entry.hideTimer)
    }
    flashesByLeafId.delete(leafId)
    pruned = true
  }
  if (pruned) {
    emit()
  }
}

/** Registers a listener notified whenever any pane's flash visibility changes. */
export function subscribeTerminalCopyFlash(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function isTerminalCopyFlashVisible(leafId: TerminalLeafId): boolean {
  return flashesByLeafId.get(leafId)?.visible ?? false
}

/** Subscribes a component to one pane's flash visibility, false until hydrated on the client. */
export function useTerminalCopyFlash(leafId: TerminalLeafId): boolean {
  return useSyncExternalStore(
    subscribeTerminalCopyFlash,
    () => isTerminalCopyFlashVisible(leafId),
    () => false
  )
}
