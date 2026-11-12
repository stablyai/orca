import { useCallback, useMemo, useState } from 'react'
import type { NativeChatWorktreeForkMode } from './native-chat-worktree-fork'
import type { NativeChatWorktreeForkDialog } from './use-native-chat-fork'

/** Which response the new-worktree fork dialog copies through, in which mode, with which draft. */
export function useNativeChatWorktreeForkDialog(
  inFlight: { current: boolean },
  latestForkItemId: () => string | undefined
) {
  const [worktreeFork, setWorktreeFork] = useState<{
    throughItemId: string
    mode: NativeChatWorktreeForkMode
    draft?: string
  } | null>(null)
  const openWorktreeFork = useCallback(
    (throughItemId: string, mode: NativeChatWorktreeForkMode = 'worktree', draft?: string) => {
      // A fork already opening owns the chat's fork; a second dialog would start another.
      if (!inFlight.current) {
        setWorktreeFork({ throughItemId, mode, ...(draft ? { draft } : {}) })
      }
    },
    [inFlight]
  )
  const openWorktreeForkLatest = useCallback(
    (mode: NativeChatWorktreeForkMode = 'worktree'): boolean => {
      const throughItemId = latestForkItemId()
      if (throughItemId) {
        openWorktreeFork(throughItemId, mode)
      }
      return throughItemId !== undefined
    },
    [latestForkItemId, openWorktreeFork]
  )
  const worktreeForkDialog = useMemo<NativeChatWorktreeForkDialog | null>(
    () => (worktreeFork ? { ...worktreeFork, close: () => setWorktreeFork(null) } : null),
    [worktreeFork]
  )
  return { openWorktreeFork, openWorktreeForkLatest, worktreeForkDialog }
}
