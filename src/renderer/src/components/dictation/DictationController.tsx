import { useEffect, useRef, useCallback, useState } from 'react'
import { useAppStore } from '@/store'
import { useAudioCapture } from '@/hooks/use-audio-capture'
import { toast } from 'sonner'
import { DictationIndicator } from './DictationIndicator'
import { captureInsertionTarget, type DictationInsertionTarget } from './dictation-insertion-target'
import {
  createDictationTranscriptDelivery,
  type DictationTranscriptDelivery
} from './dictation-transcript-delivery'
import { recordStoppedSession, waitForStoppedSession } from './dictation-stopped-sessions'
import { translate } from '@/i18n/i18n'
import {
  showDictationDisabledToast,
  showDictationNoModelToast,
  showDictationStartErrorToast
} from './dictation-start-error-toast'
import { useHoldDictationGesture } from './use-hold-dictation-gesture'
import { DICTATION_CONTROL_EVENT, type DictationControlAction } from './dictation-control-events'
import { publishDictationMeter } from './dictation-meter-store'
import { stopDictationAtAudioLimit } from './dictation-audio-limit-stop'

export function DictationController() {
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
    getCapturedChunkCount
  } = useAudioCapture(publishDictationMeter)

  const dictationStateRef = useRef(dictationState)
  dictationStateRef.current = dictationState
  const dictationRunRef = useRef(0)
  const insertionTargetRef = useRef<DictationInsertionTarget | null>(null)
  const activeSessionIdRef = useRef<string | null>(null)
  const stoppedSessionIdsRef = useRef(new Set<string>())
  const stoppedResolversRef = useRef(new Map<string, () => void>())
  const stopRequestedDuringStartRef = useRef(false)
  const finalTranscriptReceivedRef = useRef(false)
  const erroredSessionIdsRef = useRef(new Set<string>())
  const deliverTranscriptRef = useRef<DictationTranscriptDelivery | null>(null)
  // Push-to-talk restarts per utterance; report a missing preferred microphone once per preference.
  const micFallbackNotifiedForRef = useRef<string | null>(null)
  const stopDictationRef = useRef<(() => void) | null>(null)
  const [captureLive, setCaptureLive] = useState(false)

  const drainStoppedSession = useCallback((sessionId: string) => {
    void waitForStoppedSession(sessionId, stoppedSessionIdsRef, stoppedResolversRef)
  }, [])

  const finishDictationSession = useCallback(
    async (sessionId: string) => {
      dictationStateRef.current = 'stopping'
      setDictationState('stopping')
      await finishCapture()
      // A speech error during the tail already tore this session down; a newer one may own the refs now.
      if (activeSessionIdRef.current !== sessionId) {
        return
      }
      try {
        await window.api.speech.stopDictation(sessionId)
      } catch {
        // Swallow stop errors — the worker may already be torn down.
      }
      // Main stop completion can precede renderer final-text IPC; wait for this session’s stopped event before accepting the next run.
      await waitForStoppedSession(sessionId, stoppedSessionIdsRef, stoppedResolversRef)
      const sessionErrored = erroredSessionIdsRef.current.delete(sessionId)
      if (!sessionErrored && !finalTranscriptReceivedRef.current && getCapturedChunkCount() > 0) {
        toast.message(
          translate(
            'auto.components.dictation.DictationController.5d2c3e7ae3',
            'No speech detected.'
          )
        )
      }
      insertionTargetRef.current = null
      finalTranscriptReceivedRef.current = false
      stopRequestedDuringStartRef.current = false
      if (activeSessionIdRef.current === sessionId) {
        activeSessionIdRef.current = null
      }
      dictationStateRef.current = 'idle'
      setDictationState('idle')
      setPartialTranscript('')
    },
    [setDictationState, setPartialTranscript, finishCapture, getCapturedChunkCount]
  )

  const startDictation = useCallback(async () => {
    if (dictationStateRef.current !== 'idle') {
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

    const runId = dictationRunRef.current + 1
    const sessionId = String(runId)
    dictationRunRef.current = runId
    activeSessionIdRef.current = sessionId
    insertionTargetRef.current = captureInsertionTarget()
    stopRequestedDuringStartRef.current = false
    finalTranscriptReceivedRef.current = false
    erroredSessionIdsRef.current.clear()
    deliverTranscriptRef.current = createDictationTranscriptDelivery()
    dictationStateRef.current = 'starting'
    setDictationState('starting')
    setCaptureLive(false)

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
          if (dictationRunRef.current !== runId) {
            return
          }
          toast.message(
            translate(
              'auto.components.dictation.DictationController.micDisconnected',
              'Microphone disconnected. Dictation stopped.'
            )
          )
          stopDictationRef.current?.()
        },
        onAudioLimitReached: () =>
          stopDictationAtAudioLimit(dictationRunRef, runId, stopDictationRef)
      })
      captureStarted = true
      if (captureResult?.fellBackToDefaultMicrophone) {
        // Suppress fallback notices when a queued stop will tear down this startup capture.
        if (
          !stopRequestedDuringStartRef.current &&
          micFallbackNotifiedForRef.current !== preferredMicrophoneDeviceId
        ) {
          micFallbackNotifiedForRef.current = preferredMicrophoneDeviceId
          toast.message(
            translate(
              'auto.components.dictation.DictationController.micFallback',
              'Selected microphone unavailable. Using system default.'
            )
          )
        }
      } else {
        micFallbackNotifiedForRef.current = null
      }
      if (stopRequestedDuringStartRef.current) {
        stopCapture({ preserveBufferedAudio: true })
      }
      if (dictationRunRef.current !== runId) {
        discardBufferedAudio()
        stopCapture()
        insertionTargetRef.current = null
        return
      }
      setCaptureLive(true)

      await window.api.speech.startDictation(modelId, undefined, sessionId)
      if (dictationRunRef.current !== runId) {
        discardBufferedAudio()
        insertionTargetRef.current = null
        stopCapture()
        await window.api.speech.stopDictation(sessionId).catch(() => undefined)
        drainStoppedSession(sessionId)
        return
      }

      await flushBufferedAudio()
      if (dictationRunRef.current !== runId) {
        discardBufferedAudio()
        insertionTargetRef.current = null
        stopCapture()
        await window.api.speech.stopDictation(sessionId).catch(() => undefined)
        drainStoppedSession(sessionId)
        return
      }
      if (stopRequestedDuringStartRef.current) {
        await finishDictationSession(sessionId)
        return
      }

      dictationStateRef.current = 'listening'
      setDictationState('listening')
      recordFeatureInteraction('voice-dictation')
    } catch (err) {
      if (dictationRunRef.current !== runId) {
        return
      }
      await window.api.speech.stopDictation(sessionId).catch(() => undefined)
      drainStoppedSession(sessionId)
      if (captureStarted) {
        stopCapture()
      }
      discardBufferedAudio()
      const message = String(err)
      insertionTargetRef.current = null
      stopRequestedDuringStartRef.current = false
      finalTranscriptReceivedRef.current = false
      erroredSessionIdsRef.current.clear()
      activeSessionIdRef.current = null
      setPartialTranscript('')
      if (message.includes('dictation_canceled')) {
        dictationStateRef.current = 'idle'
        setDictationState('idle')
        return
      }
      dictationStateRef.current = 'error'
      setDictationState('error')
      showDictationStartErrorToast(message)
      dictationStateRef.current = 'idle'
      setDictationState('idle')
    }
  }, [
    settings,
    setDictationState,
    startCapture,
    flushBufferedAudio,
    discardBufferedAudio,
    stopCapture,
    finishDictationSession,
    drainStoppedSession,
    setPartialTranscript,
    recordFeatureInteraction
  ])

  const stopDictation = useCallback(async () => {
    if (dictationStateRef.current === 'starting') {
      stopRequestedDuringStartRef.current = true
      dictationStateRef.current = 'stopping'
      setDictationState('stopping')
      void finishCapture({ preserveBufferedAudio: true })
      return
    }

    if (dictationStateRef.current !== 'listening') {
      return
    }

    const sessionId = activeSessionIdRef.current
    if (!sessionId) {
      return
    }
    await finishDictationSession(sessionId)
  }, [finishDictationSession, setDictationState, finishCapture])

  // Capture opens before stopDictation exists; bridge through a ref to avoid cyclic callback dependencies.
  stopDictationRef.current = () => void stopDictation()

  // Toggle mode uses intercepted main IPC so the chord cannot reach xterm or system shortcuts.
  useEffect(() => {
    const mode = settings?.voice?.dictationMode ?? 'toggle'
    if (mode !== 'toggle') {
      return
    }

    const handleKeyDown = (): void => {
      if (!settings?.voice?.enabled || dictationStateRef.current === 'stopping') {
        return
      }
      if (dictationStateRef.current === 'listening' || dictationStateRef.current === 'starting') {
        void stopDictation()
      } else {
        void startDictation()
      }
    }

    const cleanup = window.api.ui.onDictationKeyDown(handleKeyDown)
    return cleanup
  }, [settings?.voice?.dictationMode, settings?.voice?.enabled, startDictation, stopDictation])

  useEffect(() => {
    const canDictate = (): boolean => Boolean(settings?.voice?.enabled)
    const handleControl = (event: Event): void => {
      if (!canDictate() || dictationStateRef.current === 'stopping') {
        return
      }
      const action = (event as CustomEvent<DictationControlAction>).detail
      if (action === 'start') {
        if (dictationStateRef.current === 'idle') {
          void startDictation()
        }
        return
      }
      if (action === 'stop') {
        if (dictationStateRef.current === 'listening' || dictationStateRef.current === 'starting') {
          void stopDictation()
        }
        return
      }
      if (dictationStateRef.current === 'listening' || dictationStateRef.current === 'starting') {
        void stopDictation()
      } else {
        void startDictation()
      }
    }
    document.addEventListener(DICTATION_CONTROL_EVENT, handleControl)
    return () => document.removeEventListener(DICTATION_CONTROL_EVENT, handleControl)
  }, [settings?.voice?.enabled, startDictation, stopDictation])

  useHoldDictationGesture({
    dictationStateRef,
    keybindings,
    settings,
    startDictation,
    stopDictation
  })

  useEffect(() => {
    const cleanupPartial = window.api.speech.onPartialTranscript((data) => {
      if (data.sessionId !== activeSessionIdRef.current) {
        return
      }
      setPartialTranscript(data.text)
    })

    const cleanupFinal = window.api.speech.onFinalTranscript((data) => {
      if (data.sessionId !== activeSessionIdRef.current || !data.text) {
        return
      }
      setPartialTranscript('')
      finalTranscriptReceivedRef.current = true
      deliverTranscriptRef.current?.(data.text, insertionTargetRef.current)
    })

    const cleanupStopped = window.api.speech.onStopped((data) => {
      recordStoppedSession(data.sessionId, stoppedSessionIdsRef, stoppedResolversRef)
    })

    const cleanupError = window.api.speech.onError((data) => {
      if (data.sessionId !== activeSessionIdRef.current) {
        return
      }
      const sessionId = data.sessionId
      erroredSessionIdsRef.current.add(sessionId)
      dictationRunRef.current += 1
      activeSessionIdRef.current = null
      toast.error(
        translate(
          'auto.components.dictation.DictationController.de136f1199',
          'Speech error: {{value0}}',
          { value0: data.error }
        )
      )
      dictationStateRef.current = 'stopping'
      setDictationState('stopping')
      stopCapture()
      discardBufferedAudio()
      void (async () => {
        await window.api.speech.stopDictation(sessionId).catch(() => undefined)
        await waitForStoppedSession(sessionId, stoppedSessionIdsRef, stoppedResolversRef)
        insertionTargetRef.current = null
        stopRequestedDuringStartRef.current = false
        finalTranscriptReceivedRef.current = false
        dictationStateRef.current = 'idle'
        setDictationState('idle')
        setPartialTranscript('')
      })()
    })

    return () => {
      cleanupPartial()
      cleanupFinal()
      cleanupStopped()
      cleanupError()
    }
  }, [setPartialTranscript, setDictationState, stopCapture, discardBufferedAudio])

  return <DictationIndicator captureLive={captureLive} />
}
