import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { requestBackgroundTerminalWorktreeMount } from '@/components/terminal/background-terminal-worktree-mount'
import {
  WAKE_HIBERNATED_AGENTS_WORKTREE_EVENT,
  type WakeHibernatedAgentsWorktreeDetail
} from '@/constants/terminal'
import type { SessionGridItem } from '../../../../shared/session-grid-types'

// A timeout offers retry, never a process-exit verdict.
const RESTORE_GRACE_MS = 15_000
type RestoreTarget = Pick<SessionGridItem, 'ptyId' | 'tabId' | 'worktreeId'>

/** Reuse the pane's recovery path; browsing alone must not wake saved agents. */
export function useSessionGridCardRestore(item: RestoreTarget): {
  restoring: boolean
  failed: boolean
  /** The last attempt ran out the grace period; the card says so instead of "not connected". */
  timedOut: boolean
  restore: () => void
  onPtyGone: () => void
} {
  const inFlightKeyRef = useRef<RestoreTarget | null>(null)
  const [restoringKey, setRestoringKey] = useState<RestoreTarget | null>(null)
  const [failedKey, setFailedKey] = useState<RestoreTarget | null>(null)
  const [timedOutKey, setTimedOutKey] = useState<RestoreTarget | null>(null)
  const { ptyId, tabId, worktreeId } = item
  // A binding change starts a new attempt even if an older PTY id later reappears.
  const key = useMemo(() => ({ worktreeId, tabId, ptyId }), [worktreeId, tabId, ptyId])

  const restore = useCallback(() => {
    if (inFlightKeyRef.current === key) {
      return
    }
    inFlightKeyRef.current = key
    setFailedKey(null)
    setTimedOutKey(null)
    setRestoringKey(key)
    window.dispatchEvent(
      new CustomEvent<WakeHibernatedAgentsWorktreeDetail>(WAKE_HIBERNATED_AGENTS_WORKTREE_EVENT, {
        detail: { worktreeId, tabIds: [tabId], wokenClaimKeys: new Set() }
      })
    )
    requestBackgroundTerminalWorktreeMount({ worktreeId, tabIds: [tabId] })
  }, [key, tabId, worktreeId])

  const onPtyGone = useCallback(() => {
    setFailedKey(key)
  }, [key])

  // Restoring ends when the store swaps the pty — the preview then mounts on the new one.
  const restoring = restoringKey === key

  useEffect(() => {
    if (!restoring) {
      return
    }
    const timer = window.setTimeout(() => {
      inFlightKeyRef.current = null
      setRestoringKey(null)
      setFailedKey(key)
      setTimedOutKey(key)
    }, RESTORE_GRACE_MS)
    return () => {
      window.clearTimeout(timer)
      inFlightKeyRef.current = null
    }
  }, [restoring, key])

  return {
    restoring,
    failed: failedKey === key,
    timedOut: timedOutKey === key,
    restore,
    onPtyGone
  }
}
