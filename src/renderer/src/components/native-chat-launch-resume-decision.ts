// Whether this launch has made its one resume decision: nothing offered, ask, or resume (from then
// on the store's `resuming` names the chats). Until then an opted-in launch may still resume any of
// this machine's chats, so nothing else offers to carry one on.

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

/** Whether this launch may still resume this machine's chats on its own: "resume automatically" is
 *  on, or its setting has not loaded yet, and the launch has not decided. */
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
