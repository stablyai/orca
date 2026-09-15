import { useState } from 'react'
import { useNow } from '@/hooks/use-now'
import { nativeChatElapsedSeconds } from '../../../../shared/native-chat-turn-status'

/** Whole seconds a counting turn has been running. The shared 1s clock is
 *  visibility-gated and collapses every in-flight turn onto one tick, instead of
 *  one interval plus one commit per turn. */
export function useNativeChatElapsedSeconds(startedAt: number | null, counting: boolean): number {
  const now = useNow(1_000, counting)
  // Why: preserves the `startedAt ?? Date.now()` epoch for the single frame
  // before the turn's startedAt lands.
  const [mountedAt] = useState(() => Date.now())
  return counting ? nativeChatElapsedSeconds(startedAt, mountedAt, now) : 0
}
