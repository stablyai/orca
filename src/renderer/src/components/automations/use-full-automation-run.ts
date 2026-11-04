import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { AutomationRun } from '../../../../shared/automations-types'
import { automationActionAvailability } from './automation-captured-owner'
import { readFullAutomationRun } from './automation-scoped-list-client'
import type { SelectedAutomationRunHistoryOutcome } from './use-selected-automation-run-history'

/** Fenced history lists previews, so Details reads the full row through the same owner; legacy rows were never cut. */
export function useFullAutomationRun(
  run: AutomationRun,
  history: SelectedAutomationRunHistoryOutcome
): AutomationRun {
  const captured = history.capturedOwner
  const availability = captured ? automationActionAvailability(captured, 'history') : null
  const authority =
    availability?.kind === 'owned'
      ? availability.owner.authority
      : availability?.kind === 'orphan-fenced'
        ? (captured?.authority ?? history.authority)
        : null
  const expectedOwner =
    availability?.kind === 'owned' || availability?.kind === 'orphan-fenced'
      ? availability.precondition
      : null
  // Only cut previews re-read; a new status or capture re-reads, and another owner never answers.
  const key =
    authority && expectedOwner && run.outputSnapshot?.truncated
      ? JSON.stringify([
          authority,
          expectedOwner,
          run.id,
          run.status,
          run.outputSnapshot?.capturedAt
        ])
      : null
  const latest = useRef({ authority, expectedOwner, run })
  useLayoutEffect(() => {
    latest.current = { authority, expectedOwner, run }
  })
  const [full, setFull] = useState<{ key: string; run: AutomationRun } | null>(null)
  useEffect(() => {
    const { authority, expectedOwner, run } = latest.current
    if (!key || !authority || !expectedOwner) {
      return
    }
    let current = true
    // A failed read keeps the preview, which is marked truncated.
    readFullAutomationRun(authority, expectedOwner, run).then(
      (row) => {
        if (current && row) {
          setFull({ key, run: row })
        }
      },
      () => {}
    )
    return () => {
      current = false
    }
  }, [key])
  return full?.key === key ? full.run : run
}
