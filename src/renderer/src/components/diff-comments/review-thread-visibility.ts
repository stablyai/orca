import { useSyncExternalStore } from 'react'

// Session-scoped toggle shared by every branch-diff surface, so hiding
// comments in one view hides them everywhere until toggled back.
let reviewThreadsVisible = true
const listeners = new Set<() => void>()

export function useReviewThreadsVisible(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    () => reviewThreadsVisible
  )
}

export function setReviewThreadsVisible(visible: boolean): void {
  if (reviewThreadsVisible === visible) {
    return
  }
  reviewThreadsVisible = visible
  for (const listener of listeners) {
    listener()
  }
}
