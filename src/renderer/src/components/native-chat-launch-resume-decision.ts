// Suppress competing continuation offers until the launch makes its resume decision and publishes resuming ids.

import { useSyncExternalStore } from 'react'
import { useAppStore } from '../store'

let decided = false
const listeners = new Set<() => void>()

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function getDecided(): boolean {
  return decided
}

export function markNativeChatLaunchResumeDecided(): void {
  if (!decided) {
    decided = true
    for (const listener of listeners) {
      listener()
    }
  }
}

/** Pending until launch decides while automatic resume is enabled or its setting has not loaded. */
export function useNativeChatLaunchResumePending(): boolean {
  const launchDecided = useSyncExternalStore(subscribe, getDecided, getDecided)
  const autoResume = useAppStore((state) => state.settings?.nativeChatResumeWorkOnRestart)
  return !launchDecided && autoResume !== false
}

/** @internal - tests need a clean module between cases. */
export function _resetNativeChatLaunchResumeDecision(): void {
  decided = false
  listeners.clear()
}
