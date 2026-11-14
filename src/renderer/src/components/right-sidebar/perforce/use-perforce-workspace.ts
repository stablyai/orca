import { useCallback, useEffect, useState } from 'react'
import {
  detectPerforceWorkspace,
  forgetPerforceDetection,
  isPerforceDetectionPending
} from '@/lib/perforce-workspace-detection'
import {
  perforceWorkspaceKey,
  type PerforceWorkspaceTarget
} from '../../../runtime/runtime-perforce-client'

/** True when a folder workspace (local, over SSH or on an Orca server) sits inside a Perforce client workspace. */
export function usePerforceWorkspace(
  target: PerforceWorkspaceTarget | null,
  eligible: boolean
): { isPerforce: boolean; redetect: () => void } {
  const [detected, setDetected] = useState<{ key: string; value: boolean } | null>(null)
  const [attempt, setAttempt] = useState(0)
  const key = target ? perforceWorkspaceKey(target) : ''

  const redetect = useCallback(() => {
    forgetPerforceDetection(key)
    setAttempt((n) => n + 1)
  }, [key])

  useEffect(() => {
    if (!target || !eligible) {
      return
    }
    let cancelled = false
    const run = (): void => {
      void detectPerforceWorkspace(target).then((value) => {
        if (!cancelled) {
          setDetected({ key, value })
        }
      })
    }
    run()
    // Why: a workspace set up while Orca is open should appear when the user returns to it.
    const onFocus = (): void => {
      if (!isPerforceDetectionPending(key)) {
        run()
      }
    }
    window.addEventListener('focus', onFocus)
    return () => {
      cancelled = true
      window.removeEventListener('focus', onFocus)
    }
  }, [target, eligible, key, attempt])

  return {
    isPerforce: Boolean(eligible && target && detected?.key === key && detected.value),
    redetect
  }
}
