import { useEffect, useState } from 'react'

// Why: detection shells out to `p4 info` (over SSH for remote folders), so remember answers per workspace.
const detectionByKey = new Map<string, Promise<boolean>>()

function detectPerforceWorkspace(worktreePath: string, connectionId?: string): Promise<boolean> {
  const key = `${connectionId ?? ''}|${worktreePath}`
  let pending = detectionByKey.get(key)
  if (!pending) {
    pending = Promise.resolve()
      .then(() => window.api.perforce.detect({ worktreePath, connectionId }))
      .then((result) => {
        // Failures (offline host, p4 missing) must be retried on the next mount, not remembered.
        if (!result.isWorkspace && result.reason !== 'not-in-workspace') {
          detectionByKey.delete(key)
        }
        return result.isWorkspace
      })
      .catch(() => {
        detectionByKey.delete(key)
        return false
      })
    detectionByKey.set(key, pending)
  }
  return pending
}

/** True when a folder workspace (local or over SSH) sits inside a Perforce client workspace. */
export function usePerforceWorkspace(
  worktreePath: string | null,
  connectionId: string | null | undefined,
  eligible: boolean
): boolean {
  const [detected, setDetected] = useState<{ key: string; value: boolean } | null>(null)
  const key = `${connectionId ?? ''}|${worktreePath ?? ''}`

  useEffect(() => {
    if (!worktreePath || !eligible) {
      return
    }
    let cancelled = false
    void detectPerforceWorkspace(worktreePath, connectionId ?? undefined).then((value) => {
      if (!cancelled) {
        setDetected({ key, value })
      }
    })
    return () => {
      cancelled = true
    }
  }, [worktreePath, connectionId, eligible, key])

  return Boolean(eligible && worktreePath && detected?.key === key && detected.value)
}
