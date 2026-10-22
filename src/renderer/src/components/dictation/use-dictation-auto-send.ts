import { useCallback, useEffect, useRef } from 'react'
import { useAppStore } from '@/store'
import type { DictationInsertionTarget } from './dictation-insertion-target'
import {
  armDictationAutoSend,
  DICTATION_CANCEL_AUTO_SEND_EVENT,
  resolveDictationAutoSendDelayMs,
  resolveDictationAutoSendElement,
  type DictationAutoSend
} from './dictation-auto-send'

export type FinishedDictationSession = {
  finalTranscriptReceived: boolean
  sessionErrored: boolean
  target: DictationInsertionTarget | null
}

async function allDelivered(insertions: readonly Promise<boolean>[]): Promise<boolean> {
  const results = await Promise.allSettled(insertions)
  return (
    results.length > 0 && results.every((result) => result.status === 'fulfilled' && result.value)
  )
}

/** Owns the one pending send a finished dictation can start, and everything that cancels it. */
export function useDictationAutoSend(): {
  trackInsertion: (insertion: Promise<boolean>) => void
  startAfterSession: (session: FinishedDictationSession) => void
} {
  const setPendingDictationAutoSend = useAppStore((s) => s.setPendingDictationAutoSend)
  const dictationState = useAppStore((s) => s.dictationState)
  const voiceEnabled = useAppStore((s) => s.settings?.voice?.enabled)
  const autoSendEnabled = useAppStore((s) => s.settings?.voice?.autoSendAfterDictation)
  const autoSendRef = useRef<DictationAutoSend | null>(null)
  const pendingInsertionsRef = useRef<Promise<boolean>[]>([])

  const cancel = useCallback(() => {
    autoSendRef.current?.cancel()
  }, [])

  const trackInsertion = useCallback((insertion: Promise<boolean>) => {
    pendingInsertionsRef.current.push(insertion)
  }, [])

  const startAfterSession = useCallback(
    (session: FinishedDictationSession) => {
      cancel()
      const insertions = pendingInsertionsRef.current
      pendingInsertionsRef.current = []
      const voice = useAppStore.getState().settings?.voice
      const element = resolveDictationAutoSendElement({
        ...session,
        enabled: Boolean(voice?.enabled && voice.autoSendAfterDictation)
      })
      if (!element) {
        return
      }
      const autoSend = armDictationAutoSend(element, {
        delivered: allDelivered(insertions),
        delayMs: resolveDictationAutoSendDelayMs(voice?.autoSendDelayMs),
        onCountdown: (deadline) => setPendingDictationAutoSend({ deadline }),
        onSettled: () => {
          if (autoSendRef.current === autoSend) {
            autoSendRef.current = null
          }
          setPendingDictationAutoSend(null)
        }
      })
      autoSendRef.current = autoSend
    },
    [cancel, setPendingDictationAutoSend]
  )

  useEffect(() => {
    // Why: new speech appends to the same draft; its own stop starts a fresh countdown.
    if (dictationState === 'starting') {
      pendingInsertionsRef.current = []
      cancel()
    }
  }, [dictationState, cancel])

  useEffect(() => {
    if (!voiceEnabled || !autoSendEnabled) {
      cancel()
    }
  }, [voiceEnabled, autoSendEnabled, cancel])

  useEffect(() => {
    document.addEventListener(DICTATION_CANCEL_AUTO_SEND_EVENT, cancel)
    return () => {
      document.removeEventListener(DICTATION_CANCEL_AUTO_SEND_EVENT, cancel)
      cancel()
    }
  }, [cancel])

  return { trackInsertion, startAfterSession }
}
