import { useEffect, useRef, useCallback } from 'react'
import { useAppStore } from '@/store'
import { useAudioCapture } from '@/hooks/use-audio-capture'
import { toast } from 'sonner'
import { DictationIndicator } from './DictationIndicator'
import {
  captureInsertionTarget,
  insertText,
  type DictationInsertionTarget
} from './dictation-insertion-target'
import { formatFinalTranscriptSegment } from './dictation-final-segments'
import { recordStoppedSession, waitForStoppedSession } from './dictation-stopped-sessions'
import { translate } from '@/i18n/i18n'
import { showDictationStartErrorToast } from './dictation-start-error-toast'
import { useDictationPlaybackSuppression } from './use-dictation-playback-suppression'
import * as dictationRunAbort from './dictation-run-abort'
import { useHoldDictationGesture } from './use-hold-dictation-gesture'
import { DICTATION_CONTROL_EVENT, type DictationControlAction } from './dictation-control-events'
import { publishDictationMeter } from './dictation-meter-store'

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
    flushBufferedAudio,
    discardBufferedAudio,
    getCapturedChunkCount
  } = useAudioCapture(publishDictationMeter)
  const { acquirePlaybackSuppression, releasePlaybackSuppression } =
    useDictationPlaybackSuppression()

  const dictationStateRef = useRef(dictationState)
  dictationStateRef.current = dictationState
  const dictationRunRef = useRef(0)
  const holdGestureActiveRef = useRef(false)
  const insertionTargetRef = useRef<DictationInsertionTarget | null>(null)
  const activeSessionIdRef = useRef<string | null>(null)
  const stoppedSessionIdsRef = useRef(new Set<string>())
  const stoppedResolversRef = useRef(new Map<string, () => void>())
  const stopRequestedDuringStartRef = useRef(false)
  const finalTranscriptReceivedRef = useRef(false)
  const erroredSessionIdsRef = useRef(new Set<string>())
  const intentionalTargetCancellationRef = useRef(false)
  const insertedFinalTranscriptRef = useRef('')
  // Why: push-to-talk restarts capture per utterance; toast once per preference,
  // not once per press, while the selected mic stays gone.
  const micFallbackNotifiedForRef = useRef<string | null>(null)
  const stopDictationRef = useRef<(() => void) | null>(null)

  const drainStoppedSession = useCallback((sessionId: string) => {
    void waitForStoppedSession(sessionId, stoppedSessionIdsRef, stoppedResolversRef)
  }, [])

  const finishDictationSession = useCallback(
    async (sessionId: string) => {
      dictationStateRef.current = 'stopping'
      setDictationState('stopping')
      stopCapture()
      await releasePlaybackSuppression(sessionId)
      try {
        await window.api.speech.stopDictation(sessionId)
      } catch {
        // Swallow stop errors — the worker may already be torn down.
      }
      // Why: stopDictation() resolves on main-process completion, while final
      // transcript delivery is renderer IPC. Wait for this session's stopped
      // event so old finals cannot be mistaken for the next dictation run.
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
      insertedFinalTranscriptRef.current = ''
      intentionalTargetCancellationRef.current = false
      stopRequestedDuringStartRef.current = false
      if (activeSessionIdRef.current === sessionId) {
        activeSessionIdRef.current = null
      }
      dictationStateRef.current = 'idle'
      setDictationState('idle')
      setPartialTranscript('')
    },
    [setDictationState, setPartialTranscript, stopCapture, getCapturedChunkCount, releasePlaybackSuppression]
  )

  const startDictation = useCallback(async () => {
    if (dictationStateRef.current !== 'idle') {
      return
    }

    const modelId = settings?.voice?.sttModel
    if (!modelId) {
      dictationRunAbort.showNoSpeechModelToast()
      return
    }

    if (!settings?.voice?.enabled) {
      toast('Voice dictation is disabled. Enable it in Settings > Voice.')
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
    insertedFinalTranscriptRef.current = ''
    intentionalTargetCancellationRef.current = false
    dictationStateRef.current = 'starting'
    setDictationState('starting')

    let captureStarted = false

    try {
      if (settings.voice.muteSystemAudioDuringDictation) {
        const suppressionOutcome = await acquirePlaybackSuppression(sessionId)
        if (suppressionOutcome === 'canceled') {
          if (dictationRunRef.current === runId) {
            activeSessionIdRef.current = null
            dictationStateRef.current = 'idle'
            setDictationState('idle')
            setPartialTranscript('')
          }
          return
        }
      }
      if (dictationRunRef.current !== runId) {
        await releasePlaybackSuppression(sessionId)
        return
      }
      // Why: worker startup can take seconds after idle teardown. Capture first
      // and buffer locally so speech during "Starting..." is not discarded.
      const preferredMicrophoneDeviceId = settings?.voice?.microphoneDeviceId ?? null
      const captureResult = await startCapture({
        bufferAudio: true,
        sessionId,
        microphoneDeviceId: preferredMicrophoneDeviceId,
        microphoneDeviceLabel: settings?.voice?.microphoneDeviceLabel ?? null,
        onCaptureLost: () => {
          dictationRunAbort.handleDictationCaptureLost({
            isStaleRun: dictationRunRef.current !== runId,
            stopDictation: () => stopDictationRef.current?.()
          })
        }
      })
      captureStarted = true
      if (captureResult?.fellBackToDefaultMicrophone) {
        // Why: a stop requested during startup tears this capture down below, so the
        // notice would describe a fallback that never records anything.
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
      const abortStaleRun = (): Promise<void> =>
        dictationRunAbort.abortStaleDictationRun({
          sessionId,
          stopCapture,
          releasePlaybackSuppression,
          discardBufferedAudio,
          drainStoppedSession
        })
      if (dictationRunRef.current !== runId) {
        insertionTargetRef.current = null
        await abortStaleRun()
        return
      }

      await window.api.speech.startDictation(modelId, undefined, sessionId)
      if (dictationRunRef.current !== runId) {
        insertionTargetRef.current = null
        await abortStaleRun()
        return
      }

      await flushBufferedAudio()
      if (dictationRunRef.current !== runId) {
        insertionTargetRef.current = null
        await abortStaleRun()
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
      await dictationRunAbort.abortStaleDictationRun({
        sessionId,
        stopCapture: captureStarted ? stopCapture : () => undefined,
        releasePlaybackSuppression,
        discardBufferedAudio,
        drainStoppedSession
      })
      const message = String(err)
      insertionTargetRef.current = null
      intentionalTargetCancellationRef.current = false
      stopRequestedDuringStartRef.current = false
      finalTranscriptReceivedRef.current = false
      erroredSessionIdsRef.current.clear()
      insertedFinalTranscriptRef.current = ''
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
    recordFeatureInteraction,
    acquirePlaybackSuppression,
    releasePlaybackSuppression
  ])

  const stopDictation = useCallback(async () => {
    if (dictationStateRef.current === 'starting') {
      stopRequestedDuringStartRef.current = true
      dictationStateRef.current = 'stopping'
      setDictationState('stopping')
      stopCapture({ preserveBufferedAudio: true })
      if (activeSessionIdRef.current) {
        await releasePlaybackSuppression(activeSessionIdRef.current)
      }
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
  }, [finishDictationSession, setDictationState, stopCapture, releasePlaybackSuppression])

  // Why: capture-loss fires from a stream opened before stopDictation exists;
  // route through a ref so the two callbacks do not depend on each other.
  stopDictationRef.current = () => void stopDictation()

  // Toggle mode: use IPC from main process (before-input-event intercepts
  // the keyDown so Cmd+E doesn't reach xterm or trigger system shortcuts).
  useEffect(() => {
    const mode = settings?.voice?.dictationMode ?? 'toggle'
    if (mode !== 'toggle') {
      return
    }

    const handleKeyDown = (): void => {
      if (
        !settings?.voice?.enabled ||
        !settings.voice.sttModel ||
        dictationStateRef.current === 'stopping'
      ) {
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
  }, [
    settings?.voice?.dictationMode,
    settings?.voice?.enabled,
    settings?.voice?.sttModel,
    startDictation,
    stopDictation
  ])

  useEffect(() => {
    const canDictate = (): boolean => Boolean(settings?.voice?.enabled && settings.voice.sttModel)
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
  }, [settings?.voice?.enabled, settings?.voice?.sttModel, startDictation, stopDictation])

  useHoldDictationGesture({
    dictationStateRef,
    holdGestureActiveRef,
    insertionTargetRef,
    intentionalTargetCancellationRef,
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
      const target = insertionTargetRef.current
      if (target) {
        const textToInsert = formatFinalTranscriptSegment(
          data.text,
          insertedFinalTranscriptRef.current
        )
        insertText(textToInsert, target)
        insertedFinalTranscriptRef.current += textToInsert
      } else if (!intentionalTargetCancellationRef.current) {
        dictationRunAbort.showNoFocusedTargetToast()
      }
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
        await releasePlaybackSuppression(sessionId)
        await window.api.speech.stopDictation(sessionId).catch(() => undefined)
        await waitForStoppedSession(sessionId, stoppedSessionIdsRef, stoppedResolversRef)
        insertionTargetRef.current = null
        intentionalTargetCancellationRef.current = false
        stopRequestedDuringStartRef.current = false
        finalTranscriptReceivedRef.current = false
        insertedFinalTranscriptRef.current = ''
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
  }, [setPartialTranscript, setDictationState, stopCapture, discardBufferedAudio, releasePlaybackSuppression])

  return <DictationIndicator />
}
