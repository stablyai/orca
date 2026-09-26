import { useEffect, useState } from 'react'

// Why: detection shells out to `p4 info`, so remember the answer per workspace path across remounts.
const detectionByPath = new Map<string, Promise<boolean>>()

function detectPerforceWorkspace(worktreePath: string): Promise<boolean> {
  let pending = detectionByPath.get(worktreePath)
  if (!pending) {
    pending = Promise.resolve()
      .then(() => window.api.perforce.detect({ worktreePath }))
      .then((result) => result.isWorkspace)
      .catch(() => false)
    detectionByPath.set(worktreePath, pending)
  }
  return pending
}

/** True when a local folder workspace sits inside a Perforce client workspace. */
export function usePerforceWorkspace(worktreePath: string | null, eligible: boolean): boolean {
  const [detected, setDetected] = useState<{ path: string; value: boolean } | null>(null)

  useEffect(() => {
    if (!worktreePath || !eligible) {
      return
    }
    let cancelled = false
    void detectPerforceWorkspace(worktreePath).then((value) => {
      if (!cancelled) {
        setDetected({ path: worktreePath, value })
      }
    })
    return () => {
      cancelled = true
    }
  }, [worktreePath, eligible])

  return Boolean(eligible && worktreePath && detected?.path === worktreePath && detected.value)
}
