import { useCallback, useEffect, useState } from 'react'

// Why: detection shells out to `p4 info` (over SSH for remote folders), so remember answers per workspace.
const detectionByKey = new Map<string, Promise<boolean>>()

function detectPerforceWorkspace(worktreePath: string, connectionId?: string): Promise<boolean> {
  const key = `${connectionId ?? ''}|${worktreePath}`
  let pending = detectionByKey.get(key)
  if (!pending) {
    pending = Promise.resolve()
      .then(() => window.api.perforce.detect({ worktreePath, connectionId }))
      .then((result) => {
        // Only positive answers are remembered so a later p4 setup/login is detected on retry.
        if (!result.isWorkspace) {
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
): { isPerforce: boolean; redetect: () => void } {
  const [detected, setDetected] = useState<{ key: string; value: boolean } | null>(null)
  const [attempt, setAttempt] = useState(0)
  const key = `${connectionId ?? ''}|${worktreePath ?? ''}`

  const redetect = useCallback(() => {
    detectionByKey.delete(key)
    setAttempt((n) => n + 1)
  }, [key])

  useEffect(() => {
    if (!worktreePath || !eligible) {
      return
    }
    let cancelled = false
    const run = (): void => {
      void detectPerforceWorkspace(worktreePath, connectionId ?? undefined).then((value) => {
        if (!cancelled) {
          setDetected({ key, value })
        }
      })
    }
    run()
    // Why: a workspace set up while Orca is open should appear when the user returns to it.
    const onFocus = (): void => {
      if (!detectionByKey.has(key)) {
        run()
      }
    }
    window.addEventListener('focus', onFocus)
    return () => {
      cancelled = true
      window.removeEventListener('focus', onFocus)
    }
  }, [worktreePath, connectionId, eligible, key, attempt])

  return {
    isPerforce: Boolean(eligible && worktreePath && detected?.key === key && detected.value),
    redetect
  }
}
