import { useCallback, useEffect, useRef, useState } from 'react'
import { requestBackgroundTerminalWorktreeMount } from '@/components/terminal/background-terminal-worktree-mount'
import type { SessionGridItem } from '../../../../shared/session-grid-types'

// How long a background mount gets to bind a fresh pty before the card admits the pane is gone.
const RESTORE_GRACE_MS = 15_000

/**
 * A pty the store advertises can be one the last run left behind: layouts and
 * `ptyIdsByTabId` survive a restart, the processes do not, and a pane only
 * respawns when its TerminalPane mounts. A card that learns its pty is unknown
 * asks for that mount in the background, as launching from the grid does, and
 * shows the session as starting until the store binds the replacement pty.
 */
export function useSessionGridCardRestore(
  item: Pick<SessionGridItem, 'ptyId' | 'tabId' | 'worktreeId'>
): { restoring: boolean; onPtyGone: () => void } {
  const attemptedPtyIdRef = useRef<string | null>(null)
  const [restoringPtyId, setRestoringPtyId] = useState<string | null>(null)
  const { ptyId, tabId, worktreeId } = item

  const onPtyGone = useCallback(() => {
    // A second report for the same pty means the mount did not replace it: the pane is really gone.
    if (!ptyId || attemptedPtyIdRef.current === ptyId) {
      return
    }
    attemptedPtyIdRef.current = ptyId
    requestBackgroundTerminalWorktreeMount({ worktreeId, tabIds: [tabId] })
    setRestoringPtyId(ptyId)
  }, [ptyId, tabId, worktreeId])

  // Restoring ends when the store swaps the pty — the preview then mounts on the new one.
  const restoring = restoringPtyId !== null && restoringPtyId === ptyId

  useEffect(() => {
    if (!restoring) {
      return
    }
    const timer = window.setTimeout(() => setRestoringPtyId(null), RESTORE_GRACE_MS)
    return () => window.clearTimeout(timer)
  }, [restoring])

  return { restoring, onPtyGone }
}
