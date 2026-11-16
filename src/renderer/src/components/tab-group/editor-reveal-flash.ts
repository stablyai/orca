import { useCallback, useSyncExternalStore } from 'react'

// Keep in sync with the editor-reveal-flash animation in main.css.
export const EDITOR_REVEAL_FLASH_MS = 1_200

type Flash = { key: number; timer: ReturnType<typeof setTimeout> }

const flashesByViewId = new Map<string, Flash>()
const listenersByViewId = new Map<string, Set<() => void>>()
let nextFlashKey = 1

function notify(viewStateId: string): void {
  for (const listener of listenersByViewId.get(viewStateId) ?? []) {
    listener()
  }
}

/** Tints an editor view so a link that opened an already-visible document still answers the click. */
export function flashRevealedEditorView(viewStateId: string): void {
  const existing = flashesByViewId.get(viewStateId)
  if (existing) {
    clearTimeout(existing.timer)
  }
  const key = nextFlashKey++
  const timer = setTimeout(() => {
    if (flashesByViewId.get(viewStateId)?.key === key) {
      flashesByViewId.delete(viewStateId)
      notify(viewStateId)
    }
  }, EDITOR_REVEAL_FLASH_MS)
  flashesByViewId.set(viewStateId, { key, timer })
  notify(viewStateId)
}

/** The current flash key for a view (a new key restarts its animation), or null. */
export function useEditorRevealFlashKey(viewStateId: string): number | null {
  // Per-view listeners: a flash re-renders only its own overlay.
  const subscribe = useCallback(
    (listener: () => void) => {
      let listeners = listenersByViewId.get(viewStateId)
      if (!listeners) {
        listeners = new Set()
        listenersByViewId.set(viewStateId, listeners)
      }
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0 && listenersByViewId.get(viewStateId) === listeners) {
          listenersByViewId.delete(viewStateId)
        }
      }
    },
    [viewStateId]
  )
  return useSyncExternalStore(
    subscribe,
    () => flashesByViewId.get(viewStateId)?.key ?? null,
    () => null
  )
}
