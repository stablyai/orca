import { useState } from 'react'
import { useNow } from '@/hooks/use-now'
import { nativeChatElapsedSeconds } from '../../../../shared/native-chat-turn-status'

/** Share one visibility-gated second clock across running turns to avoid per-turn intervals and commits. */
export function useNativeChatElapsedSeconds(startedAt: number | null, counting: boolean): number {
  const now = useNow(1_000, counting)
  // Retain the mount epoch until the first host turn stamp arrives.
  const [mountedAt] = useState(() => Date.now())
  return counting ? nativeChatElapsedSeconds(startedAt, mountedAt, now) : 0
}
