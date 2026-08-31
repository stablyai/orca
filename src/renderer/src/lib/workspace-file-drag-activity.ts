import { useSyncExternalStore } from 'react'
import { hasWorkspaceFileDragTypes } from './workspace-file-drag'

// Why: every visible tab group asks the same question during one drag. Share a
// single pair of window listeners instead of registering them per pane.
const subscribers = new Set<() => void>()
let detachWindowListeners: (() => void) | null = null
let snapshot = false

function setSnapshot(next: boolean): void {
  if (snapshot === next) {
    return
  }
  snapshot = next
  for (const subscriber of subscribers) {
    subscriber()
  }
}

function armIfWorkspaceFileDrag(event: DragEvent): void {
  if (event.dataTransfer && hasWorkspaceFileDragTypes(event.dataTransfer)) {
    setSnapshot(true)
  }
}

function handleDragFinish(): void {
  setSnapshot(false)
}

export function getWorkspaceFileDragActiveSnapshot(): boolean {
  return snapshot
}

/** Tears the drop zones down without waiting for an event that may never arrive. */
export function disarmWorkspaceFileDrag(): void {
  setSnapshot(false)
}

export function subscribeToWorkspaceFileDragActivity(onChange: () => void): () => void {
  subscribers.add(onChange)
  if (!detachWindowListeners && typeof window !== 'undefined') {
    // Why: React delegates onDragStart to the root, so setData has not run yet
    // during capture — read the payload on the way back up instead.
    window.addEventListener('dragstart', armIfWorkspaceFileDrag)
    // Why: backstop for a source that stops dragstart short of window; by the
    // first dragenter the payload is always readable.
    window.addEventListener('dragenter', armIfWorkspaceFileDrag, true)
    window.addEventListener('dragend', handleDragFinish, true)
    // Why: NOT capture — tearing the zones down there unmounts the drop target
    // before React's delegated onDrop runs at the root, and the drop is lost.
    window.addEventListener('drop', handleDragFinish)
    detachWindowListeners = () => {
      window.removeEventListener('dragstart', armIfWorkspaceFileDrag)
      window.removeEventListener('dragenter', armIfWorkspaceFileDrag, true)
      window.removeEventListener('dragend', handleDragFinish, true)
      window.removeEventListener('drop', handleDragFinish)
    }
  }
  return () => {
    subscribers.delete(onChange)
    if (subscribers.size > 0) {
      return
    }
    detachWindowListeners?.()
    detachWindowListeners = null
    snapshot = false
  }
}

export function useWorkspaceFileDragActive(): boolean {
  return useSyncExternalStore(
    subscribeToWorkspaceFileDragActivity,
    getWorkspaceFileDragActiveSnapshot,
    () => false
  )
}

export function resetWorkspaceFileDragActivityForTests(): void {
  detachWindowListeners?.()
  subscribers.clear()
  detachWindowListeners = null
  snapshot = false
}
