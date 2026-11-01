import { useCallback, useEffect, useRef, useState } from 'react'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { emulatorErrorText } from '@/lib/emulator-error-copy'

const INTERACTION_RECHECK_MS = 5_000

function isInputBlockedError(error: unknown): error is Error {
  return error instanceof Error && 'code' in error && error.code === 'emulator_input_blocked'
}

// Pane touches go straight to the helper socket, and Device Hub can take input over mid-session.
export function useEmulatorInputCheck(worktreeId: string, liveTarget: string | null) {
  const [blocked, setBlocked] = useState<{ target: string; message: string } | null>(null)
  const lastCheckAtRef = useRef(0)

  const runCheck = useCallback(async () => {
    if (!liveTarget) {
      return
    }
    lastCheckAtRef.current = Date.now()
    try {
      await callRuntimeRpc({ kind: 'local' }, 'emulator.checkInput', { worktree: worktreeId })
      setBlocked(null)
    } catch (error) {
      if (isInputBlockedError(error)) {
        setBlocked({ target: liveTarget, message: emulatorErrorText(error, error.message) })
      }
    }
  }, [liveTarget, worktreeId])

  useEffect(() => {
    void runCheck()
  }, [runCheck])

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
