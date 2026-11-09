import { useEffect, useRef, useCallback, useState } from 'react'
import { useAppStore } from '@/store'
import { useAudioCapture } from '@/hooks/use-audio-capture'
import { toast } from 'sonner'
import { DictationIndicator } from './DictationIndicator'
import { captureInsertionTarget } from './dictation-insertion-target'
import { createDictationTranscriptDelivery } from './dictation-transcript-delivery'
import { recordStoppedSession, waitForStoppedSession } from './dictation-stopped-sessions'
import { translate } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'
import {
  showDictationDisabledToast,
  showDictationNoModelToast,
  showCloudLimitToast,
  showDictationStartErrorToast,
  showMicrophoneDisconnectedToast,
  showMicrophoneFallbackToast
} from './dictation-toasts'
import { useHoldDictationGesture } from './use-hold-dictation-gesture'
import { DICTATION_CONTROL_EVENT, type DictationControlAction } from './dictation-control-events'
import { publishDictationMeter } from './dictation-meter-store'
import { useDictationSilenceStop } from './use-dictation-silence-stop'
import { useDictationSpeechEvents } from './use-dictation-speech-events'
import {
  canStartDictation,
  initialDictationSession,
  isDictationUnderway,
  transitionDictationSession,
  type DictationSession,
  type DictationSessionEvent
} from '../../../../shared/dictation-session-machine'

export function DictationController() {
  const t = useTranslate()
  const dictationState = useAppStore((s) => s.dictationState)
  const setDictationState = useAppStore((s) => s.setDictationState)
  const setPartialTranscript = useAppStore((s) => s.setPartialTranscript)
  const recordFeatureInteraction = useAppStore((s) => s.recordFeatureInteraction)
  const settings = useAppStore((s) => s.settings)
  const keybindings = useAppStore((s) => s.keybindings)
  const {
    start: startCapture,
    stop: stopCapture,
    finish: finishCapture,
    flushBufferedAudio,
    discardBufferedAudio,
    getCapturedChunkCount,
    getLastSpeechAt
  } = useAudioCapture(publishDictationMeter)

  const sessionRef = useRef<DictationSession>(initialDictationSession)
  // Inserts the current session's finals where dictation started.
  const deliverRef = useRef<((text: string) => void) | null>(null)
  const stoppedSessionIdsRef = useRef(new Set<string>())
  const stoppedResolversRef = useRef(new Map<string, () => void>())
  // Push-to-talk restarts per utterance; report a missing preferred microphone once per preference.
  const micFallbackNotifiedForRef = useRef<string | null>(null)
  const [captureLive, setCaptureLive] = useState(false)

  const dispatch = useCallback(
    (event: DictationSessionEvent): DictationSession => {
      const previous = sessionRef.current
      const next = transitionDictationSession(previous, event)
      sessionRef.current = next
      if (next.sessionId === null) {
        deliverRef.current = null
      }
      if (next.phase !== previous.phase) {
        setDictationState(next.phase)
        if (next.phase === 'idle') {
          setPartialTranscript('')
        }
      }
      return next
    },
    [setDictationState, setPartialTranscript]
  )

  const drainStoppedSession = useCallback((sessionId: string) => {
    void waitForStoppedSession(sessionId, stoppedSessionIdsRef, stoppedResolversRef)
  }, [])

  const finishDictationSession = useCallback(
    async ({ run, sessionId }: DictationSession) => {
      if (sessionId === null) {
        return
      }
      await finishCapture()
      // A speech error during the tail already tore this session down; a newer one may be current now.
      if (sessionRef.current.run !== run) {
        return
      }
      try {
        await window.api.speech.stopDictation(sessionId)
      } catch {
        // Swallow stop errors — the worker may already be torn down.
      }
      // Main stop completion can precede renderer final-text IPC; wait for this session’s stopped event before accepting the next run.
      await waitForStoppedSession(sessionId, stoppedSessionIdsRef, stoppedResolversRef)
      if (sessionRef.current.run !== run) {
        return
      }
      if (!sessionRef.current.heardFinalText && getCapturedChunkCount() > 0) {
        toast.message(
          translate(
            'auto.components.dictation.DictationController.5d2c3e7ae3',
            'No speech detected.'
          )
        )
      }
      dispatch({ type: 'ended' })
    },
    [dispatch, finishCapture, getCapturedChunkCount]
  )

  const stopDictation = useCallback(async () => {
    const previous = sessionRef.current
    const next = dispatch({ type: 'stop' })
    if (next === previous) {
      return
    }
    if (previous.phase === 'starting') {
      // Startup finishes once the engine is up, so the buffered words land.
      void finishCapture({ preserveBufferedAudio: true })
      return
    }
    await finishDictationSession(next)
  }, [dispatch, finishCapture, finishDictationSession])

  const startDictation = useCallback(async () => {
    if (!canStartDictation(sessionRef.current.phase)) {
      return
    }

    const modelId = settings?.voice?.sttModel
    if (!modelId) {
      showDictationNoModelToast()
      return
    }

    if (!settings?.voice?.enabled) {
      showDictationDisabledToast()
      return
    }

    const { run, sessionId } = dispatch({ type: 'start' })
    if (sessionId === null) {
      return
    }
    const isCurrent = (): boolean => sessionRef.current.run === run
    const insertionTarget = captureInsertionTarget()
    const deliver = createDictationTranscriptDelivery()
    deliverRef.current = (text) => deliver(text, insertionTarget)
    setCaptureLive(false)

    // A stop that arrived while starting is still this run's stop.
    const stopQueued = (): boolean => isCurrent() && sessionRef.current.phase === 'stopping'
    const releaseStart = async (engineStarted: boolean, captureStarted = true): Promise<void> => {
      discardBufferedAudio()
      if (captureStarted) {
        stopCapture()
      }
      if (engineStarted) {
        await window.api.speech.stopDictation(sessionId).catch(() => undefined)
        drainStoppedSession(sessionId)
      }
    }

    let captureStarted = false

    try {
      // Capture and buffer before slow worker startup so speech during model load is retained.
      const preferredMicrophoneDeviceId = settings?.voice?.microphoneDeviceId ?? null
      const captureResult = await startCapture({
        bufferAudio: true,
        sessionId,
        microphoneDeviceId: preferredMicrophoneDeviceId,
        microphoneDeviceLabel: settings?.voice?.microphoneDeviceLabel ?? null,
        onCaptureLost: () => {
          if (isCurrent()) {
            showMicrophoneDisconnectedToast()
            void stopDictation()
          }
        },
        onAudioLimitReached: () => {
          if (isCurrent()) {
            showCloudLimitToast()
            void stopDictation()
          }
        }
      })
      captureStarted = true
      if (captureResult?.fellBackToDefaultMicrophone) {
        // Suppress fallback notices when a queued stop will tear down this startup capture.
        if (!stopQueued() && micFallbackNotifiedForRef.current !== preferredMicrophoneDeviceId) {
          micFallbackNotifiedForRef.current = preferredMicrophoneDeviceId
          showMicrophoneFallbackToast()
        }
      } else {
        micFallbackNotifiedForRef.current = null
      }
      if (stopQueued()) {
        stopCapture({ preserveBufferedAudio: true })
      }
      if (!isCurrent()) {
        await releaseStart(false)
        return
      }
      setCaptureLive(true)

      await window.api.speech.startDictation(modelId, undefined, sessionId)
      if (!isCurrent()) {
        await releaseStart(true)
        return
      }

      await flushBufferedAudio()
      if (!isCurrent()) {
        await releaseStart(true)
        return
      }
      if (dispatch({ type: 'engine-ready' }).phase === 'stopping') {
        await finishDictationSession(sessionRef.current)
        return
      }
      recordFeatureInteraction('voice-dictation')
    } catch (err) {
      if (!isCurrent()) {
        return
      }
      await releaseStart(true, captureStarted)
      if (!isCurrent()) {
        return
      }
      const message = String(err)
      if (message.includes('dictation_canceled')) {
        dispatch({ type: 'cancel' })
        return
      }
      dispatch({ type: 'fail' })
      showDictationStartErrorToast(message)
      dispatch({ type: 'ended' })
    }
  }, [
    settings,
    dispatch,
    startCapture,
    flushBufferedAudio,
    discardBufferedAudio,
    stopCapture,
    stopDictation,
    finishDictationSession,
    drainStoppedSession,
    recordFeatureInteraction
  ])

  const toggleDictation = useCallback(() => {
    if (isDictationUnderway(sessionRef.current.phase)) {
      void stopDictation()
    } else {
      void startDictation()
    }
  }, [startDictation, stopDictation])

  // Toggle presses, and Auto double taps (which have no release), arrive as intercepted main IPC so the chord cannot reach xterm or system shortcuts.
  useEffect(() => {
    const mode = settings?.voice?.dictationMode ?? 'auto'
    if (mode === 'hold' || !settings?.voice?.enabled) {
      return
    }
    return window.api.ui.onDictationKeyDown(toggleDictation)
  }, [settings?.voice?.dictationMode, settings?.voice?.enabled, toggleDictation])

  useEffect(() => {
    if (!settings?.voice?.enabled) {
      return
    }
    const handleControl = (event: Event): void => {
      const action = (event as CustomEvent<DictationControlAction>).detail
      if (action === 'start') {
        void startDictation()
      } else if (action === 'stop') {
        void stopDictation()
      } else {
        toggleDictation()
      }
    }
    document.addEventListener(DICTATION_CONTROL_EVENT, handleControl)
    return () => document.removeEventListener(DICTATION_CONTROL_EVENT, handleControl)
  }, [settings?.voice?.enabled, startDictation, stopDictation, toggleDictation])

  useDictationSilenceStop(
    dictationState === 'listening',
    settings?.voice?.dictationMode,
    getLastSpeechAt,
    () => void stopDictation()
  )

  useHoldDictationGesture({
    canStartDictation: () => canStartDictation(sessionRef.current.phase),
    keybindings,
    settings,
    startDictation,
    stopDictation
  })

  useDictationSpeechEvents({
    currentSessionId: () => sessionRef.current.sessionId,
    onPartial: setPartialTranscript,
    onFinal: (text) => {
      setPartialTranscript('')
      dispatch({ type: 'final-text' })
      deliverRef.current?.(text)
    },
    onStopped: (sessionId) =>
      recordStoppedSession(sessionId, stoppedSessionIdsRef, stoppedResolversRef),
    onError: (sessionId, error) => {
      toast.error(
        t('auto.components.dictation.DictationController.de136f1199', 'Speech error: {{value0}}', {
          value0: error
        })
      )
      const { run } = dispatch({ type: 'abandon' })
      stopCapture()
      discardBufferedAudio()
      void (async () => {
        await window.api.speech.stopDictation(sessionId).catch(() => undefined)
        await waitForStoppedSession(sessionId, stoppedSessionIdsRef, stoppedResolversRef)
        if (sessionRef.current.run === run) {
          dispatch({ type: 'ended' })
        }
      })()
    }
  })

  return <DictationIndicator captureLive={captureLive} />
}
