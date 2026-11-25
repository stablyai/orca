// Reports which Needs you rows are approvals, so the group sorts them first (needsYouFold).
import { useCallback, useLayoutEffect, useReducer, useRef } from 'react'

import type { BotNeedView } from './use-bot-now'

/** Whether this ask already has an approval to show. */
export function knownApproval(need: BotNeedView): boolean {
  return (
    need.kind === 'paired-ask' ||
    (need.kind === 'session' && need.row.kind === 'worker' && need.row.dot === 'permission')
  )
}

const NO_APPROVALS: ReadonlySet<string> = new Set()

/** Each reported approval key, copied once per commit into the state the card renders from. */
function copyReported(
  _shown: ReadonlySet<string>,
  reported: React.RefObject<Set<string>>
): ReadonlySet<string> {
  return new Set(reported.current)
}

/**
 * Rows report from their layout effects whether they are approvals. A commit's reports land in one
 * update before paint, so N rows cost one copy, not one per row.
 */
export function useApprovalReports(): {
  approvals: ReadonlySet<string>
  report: (key: string, approval: boolean) => void
} {
  const reported = useRef(new Set<string>())
  const queued = useRef(false)
  const [approvals, sync] = useReducer(copyReported, NO_APPROVALS)
  const report = useCallback((key: string, approval: boolean) => {
    const keys = reported.current
    if (keys.has(key) === approval) {
      return
    }
    if (approval) {
      keys.add(key)
    } else {
      keys.delete(key)
    }
    if (!queued.current) {
      queued.current = true
      sync(reported)
    }
  }, [])
  // The card's effects run after its rows': this commit's reports are queued, later ones queue anew.
  useLayoutEffect(() => {
    queued.current = false
  })
  return { approvals, report }
}
