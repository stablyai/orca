import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { AutomationRun } from '../../../../shared/automations-types'
import { automationActionAvailability } from './automation-captured-owner'
import { readFullAutomationRun } from './automation-scoped-list-client'
import type { SelectedAutomationRunHistoryOutcome } from './use-selected-automation-run-history'

export type FullAutomationRun = {
  run: AutomationRun
  /** The full read failed; `run` is still the preview. */
  failed: boolean
  retry: () => void
}

/** Fenced history lists previews, so Details reads the full row through the same owner; legacy rows were never cut. */
export function useFullAutomationRun(
  run: AutomationRun,
  history: SelectedAutomationRunHistoryOutcome
): FullAutomationRun {
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
  const latest = useRef({ authority, expectedOwner })
  useLayoutEffect(() => {
    latest.current = { authority, expectedOwner }
  })
  const [full, setFull] = useState<{ key: string; run: AutomationRun } | null>(null)
  const [failedKey, setFailedKey] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const loaded = full?.key === key
  // A failed read keeps the preview, marked truncated; Retry or the next history read of the row retries.
  useEffect(() => {
    const { authority, expectedOwner } = latest.current
    if (!key || loaded || !authority || !expectedOwner) {
      return
    }
    let current = true
    readFullAutomationRun(authority, expectedOwner, run).then(
      (row) => {
        if (current && row) {
          setFull({ key, run: row })
        }
      },
      () => {
        if (current) {
          setFailedKey(key)
        }
      }
    )
    return () => {
      current = false
    }
  }, [key, loaded, run, attempt])
  return {
    run: loaded ? full.run : run,
    failed: !loaded && key !== null && failedKey === key,
    retry: () => {
      setFailedKey(null)
      setAttempt((value) => value + 1)
    }
  }
}
