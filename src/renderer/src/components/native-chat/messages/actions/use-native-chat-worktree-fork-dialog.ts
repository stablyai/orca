import { useCallback, useMemo, useState } from 'react'
import type { NativeChatForkWindowPreset } from './fork-window/native-chat-fork-window-choices'
import type { NativeChatWorktreeForkDialog } from './use-native-chat-fork'

/** Which response the Fork window copies through, which menu item opened it, with which draft. */
export function useNativeChatWorktreeForkDialog(
  inFlight: { current: boolean },
  latestForkItemId: () => string | undefined
) {
  const [worktreeFork, setWorktreeFork] = useState<{
    throughItemId: string
    mode: NativeChatForkWindowPreset
    draft?: string
    usageLimited?: boolean
  } | null>(null)
  const openWorktreeFork = useCallback(
    (
      throughItemId: string,
      mode: NativeChatForkWindowPreset = 'worktree',
      draft?: string,
      usageLimited?: boolean
    ) => {
      // A fork already opening owns the chat's fork; a second dialog would start another.
      if (!inFlight.current) {
        setWorktreeFork({
          throughItemId,
          mode,
          ...(draft ? { draft } : {}),
          ...(usageLimited ? { usageLimited } : {})
        })
      }
    },
    [inFlight]
  )
  const openWorktreeForkLatest = useCallback(
    (mode: NativeChatForkWindowPreset = 'worktree'): boolean => {
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
