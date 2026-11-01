import { useCallback, useEffect, useRef, useState } from 'react'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { emulatorErrorText } from '@/lib/emulator-error-copy'

const INTERACTION_RECHECK_MS = 5_000

function isInputBlockedError(error: unknown): error is Error {
  return error instanceof Error && 'code' in error && error.code === 'emulator_input_blocked'
}

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
      if (!isInputBlockedError(error)) {
        return
      }
      next = { target: liveTarget, message: emulatorErrorText(error, error.message) }
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
