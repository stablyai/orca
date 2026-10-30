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

type DictationSessionOutcome = {
  finalTranscriptReceived: boolean
  sessionErrored: boolean
}

type ReportDictationOutcome = (outcome: DictationSessionOutcome) => void

async function allDelivered(insertions: readonly Promise<boolean>[]): Promise<boolean> {
  const results = await Promise.allSettled(insertions)
  return (
    results.length > 0 && results.every((result) => result.status === 'fulfilled' && result.value)
  )
}

export function useDictationAutoSend(): {
  trackInsertion: (insertion: Promise<boolean>) => void
  // Repeat calls within one dictation return the first reporter instead of re-arming.
  watchStopping: (target: DictationInsertionTarget | null) => ReportDictationOutcome
} {
  const setPendingDictationAutoSend = useAppStore((s) => s.setPendingDictationAutoSend)
  const dictationState = useAppStore((s) => s.dictationState)
  const voiceEnabled = useAppStore((s) => s.settings?.voice?.enabled)
  const autoSendEnabled = useAppStore((s) => s.settings?.voice?.autoSendAfterDictation)
  const autoSendRef = useRef<DictationAutoSend | null>(null)
  const pendingInsertionsRef = useRef<Promise<boolean>[]>([])
  const reportOutcomeRef = useRef<ReportDictationOutcome | null>(null)

  const cancel = useCallback(() => {
    autoSendRef.current?.cancel()
  }, [])

  const trackInsertion = useCallback((insertion: Promise<boolean>) => {
    pendingInsertionsRef.current.push(insertion)
  }, [])

  const startWhenStopping = useCallback(
    (target: DictationInsertionTarget | null, outcome: Promise<DictationSessionOutcome>) => {
      cancel()
      const voice = useAppStore.getState().settings?.voice
      const element = resolveDictationAutoSendElement({
        target,
        enabled: Boolean(voice?.enabled && voice.autoSendAfterDictation)
      })
      if (!element) {
        return
      }
      const delivered = outcome.then(({ finalTranscriptReceived, sessionErrored }) => {
        const insertions = pendingInsertionsRef.current
        pendingInsertionsRef.current = []
        return finalTranscriptReceived && !sessionErrored && allDelivered(insertions)
      })
      const autoSend = armDictationAutoSend(element, {
        delivered,
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

  const watchStopping = useCallback(
    (target: DictationInsertionTarget | null): ReportDictationOutcome => {
      if (reportOutcomeRef.current) {
        return reportOutcomeRef.current
      }
      const outcome = Promise.withResolvers<DictationSessionOutcome>()
      const report: ReportDictationOutcome = (result) => {
        if (reportOutcomeRef.current === report) {
          reportOutcomeRef.current = null
        }
        outcome.resolve(result)
      }
      reportOutcomeRef.current = report
      startWhenStopping(target, outcome.promise)
      return report
    },
    [startWhenStopping]
  )

  useEffect(() => {
    // New speech appends to the same draft; its own Stop starts a fresh countdown.
    if (dictationState === 'starting') {
      pendingInsertionsRef.current = []
      reportOutcomeRef.current = null
      cancel()
    }
  }, [dictationState, cancel])

  useEffect(() => {
    // A failed start or speech error ends dictation without reporting; stop watching for takeover.
    if (dictationState === 'idle') {
      reportOutcomeRef.current?.({ finalTranscriptReceived: false, sessionErrored: true })
    }
  }, [dictationState])

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

  return { trackInsertion, watchStopping }
}
