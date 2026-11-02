import { useCallback, useEffect, useRef, useState } from 'react'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { emulatorErrorText } from '@/lib/emulator-error-copy'
import { hasRuntimeRpcErrorCode } from '../../../../shared/runtime-rpc-error-code'
import { EMULATOR_FAILURE_COPY } from '../../../../shared/emulator-failure-copy'

const INTERACTION_RECHECK_MS = 5_000

// Pane touches go straight to the helper socket, and Device Hub can take input over mid-session.
// attachKey changes on every attach, so reattaching the same device after the fix rechecks.
export function useEmulatorInputCheck(
  worktreeId: string,
  liveTarget: string | null,
  attachKey: string | undefined
) {
  const [blocked, setBlocked] = useState<{ target: string; message: string } | null>(null)
  const lastCheckAtRef = useRef(0)
  const latestCheckRef = useRef(0)

  const runCheck = useCallback(async () => {
    if (!liveTarget) {
      return
    }
    const checkId = ++latestCheckRef.current
    lastCheckAtRef.current = Date.now()
    let next: { target: string; message: string } | null = null
    try {
      await callRuntimeRpc({ kind: 'local' }, 'emulator.checkInput', { worktree: worktreeId })
    } catch (error) {
      if (!hasRuntimeRpcErrorCode(error, 'emulator_input_blocked')) {
        return
      }
      next = {
        target: liveTarget,
        message: emulatorErrorText(error, EMULATOR_FAILURE_COPY.deviceHubInputBlocked)
      }
    }
    // A slower check from a previous attach must not overwrite a newer answer.
    if (checkId === latestCheckRef.current) {
      setBlocked(next)
    }
  }, [liveTarget, worktreeId])

  useEffect(() => {
    void runCheck()
  }, [runCheck, attachKey])

  const checkOnInteraction = useCallback(() => {
    if (Date.now() - lastCheckAtRef.current >= INTERACTION_RECHECK_MS) {
      void runCheck()
    }
  }, [runCheck])

  return {
    inputError: blocked && blocked.target === liveTarget ? blocked.message : null,
    checkOnInteraction
  }
}
