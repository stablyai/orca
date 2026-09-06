import { useEffect, useRef, useCallback } from 'react'
import { useAppStore } from '@/store'
import { useAudioCapture } from '@/hooks/use-audio-capture'
import { toast } from 'sonner'
import { DictationIndicator } from './DictationIndicator'
import { captureInsertionTarget, type DictationInsertionTarget } from './dictation-insertion-target'
import { waitForStoppedSession } from './dictation-stopped-sessions'
import { translate } from '@/i18n/i18n'
import { showDictationStartErrorToast } from './dictation-start-error-toast'
import { useHoldDictationGesture } from './use-hold-dictation-gesture'
import { canStopDictationSession } from './dictation-control-actions'
import { useDictationTranscriptListeners } from './use-dictation-transcript-listeners'
import { useDictationUtteranceControls } from './use-dictation-utterance-controls'
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
    pause: pauseCapture,
    resume: resumeCapture,
    flushBufferedAudio,
    discardBufferedAudio,
    clearLiveAudio,
    getCapturedChunkCount
  } = useAudioCapture(publishDictationMeter)

  const dictationStateRef = useRef(dictationState)
  dictationStateRef.current = dictationState
  const dictationRunRef = useRef(0)
  const holdGestureActiveRef = useRef(false)
  const insertionTargetRef = useRef<DictationInsertionTarget | null>(null)
  const activeSessionIdRef = useRef<string | null>(null)
  const stoppedSessionIdsRef = useRef(new Set<string>())
  const stoppedResolversRef = useRef(new Map<string, () => void>())
  const stopRequestedDuringStartRef = useRef(false)
  const pauseRequestedDuringStartRef = useRef(false)
  const sessionReadyRef = useRef(false)
  const finalTranscriptReceivedRef = useRef(false)
  const erroredSessionIdsRef = useRef(new Set<string>())
  const intentionalTargetCancellationRef = useRef(false)
  const insertedFinalTranscriptRef = useRef('')
  // Why: push-to-talk restarts capture per utterance; toast once per preference,
  // not once per press, while the selected mic stays gone.
  const micFallbackNotifiedForRef = useRef<string | null>(null)
  const stopDictationRef = useRef<(() => void) | null>(null)
  const clearingUtteranceRef = useRef(false)

  const drainStoppedSession = useCallback((sessionId: string) => {
    void waitForStoppedSession(sessionId, stoppedSessionIdsRef, stoppedResolversRef)
  }, [])

  const finishDictationSession = useCallback(
    async (sessionId: string) => {
      dictationStateRef.current = 'stopping'
      setDictationState('stopping')
      stopCapture()
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
      pauseRequestedDuringStartRef.current = false
      sessionReadyRef.current = false
      clearingUtteranceRef.current = false
      if (activeSessionIdRef.current === sessionId) {
        activeSessionIdRef.current = null
      }
      dictationStateRef.current = 'idle'
      setDictationState('idle')
      setPartialTranscript('')
    },
    [setDictationState, setPartialTranscript, stopCapture, getCapturedChunkCount]
  )

  const startDictation = useCallback(async () => {
    if (dictationStateRef.current !== 'idle') {
      return
    }

    const modelId = settings?.voice?.sttModel
    if (!modelId) {
      toast('No speech model selected. Download one in Settings > Voice.', {
        action: {
          label: translate(
            'auto.components.dictation.DictationController.bb7f599ee7',
            'Open Settings'
          ),
          onClick: () => {
            useAppStore.getState().openSettingsTarget({ pane: 'voice', repoId: null })
            useAppStore.getState().openSettingsPage()
          }
        }
      })
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
    pauseRequestedDuringStartRef.current = false
    sessionReadyRef.current = false
    finalTranscriptReceivedRef.current = false
    erroredSessionIdsRef.current.clear()
    insertedFinalTranscriptRef.current = ''
    intentionalTargetCancellationRef.current = false
    clearingUtteranceRef.current = false
    dictationStateRef.current = 'starting'
    setDictationState('starting')

    let captureStarted = false

    try {
      // Why: worker startup can take seconds after idle teardown. Capture first
      // and buffer locally so speech during "Starting..." is not discarded.
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
        }
      })
      captureStarted = true
      if (pauseRequestedDuringStartRef.current) {
        pauseCapture()
      }
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
      if (dictationRunRef.current !== runId) {
        discardBufferedAudio()
        stopCapture()
        insertionTargetRef.current = null
        return
      }

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

      sessionReadyRef.current = true
      if (pauseRequestedDuringStartRef.current) {
        pauseCapture()
        dictationStateRef.current = 'paused'
        setDictationState('paused')
      } else {
        dictationStateRef.current = 'listening'
        setDictationState('listening')
      }
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
      intentionalTargetCancellationRef.current = false
      stopRequestedDuringStartRef.current = false
      pauseRequestedDuringStartRef.current = false
      sessionReadyRef.current = false
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
    pauseCapture,
    stopCapture,
    finishDictationSession,
    drainStoppedSession,
    setPartialTranscript,
    recordFeatureInteraction
  ])

  const stopDictation = useCallback(async () => {
    const abortingUnreadySession =
      dictationStateRef.current === 'starting' ||
      (dictationStateRef.current === 'paused' && !sessionReadyRef.current)
    if (abortingUnreadySession) {
      stopRequestedDuringStartRef.current = true
      dictationStateRef.current = 'stopping'
      setDictationState('stopping')
      stopCapture({ preserveBufferedAudio: true })
      return
    }

    if (dictationStateRef.current !== 'listening' && dictationStateRef.current !== 'paused') {
      return
    }

    const sessionId = activeSessionIdRef.current
    if (!sessionId) {
      return
    }
    await finishDictationSession(sessionId)
  }, [finishDictationSession, setDictationState, stopCapture])

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
      if (canStopDictationSession(dictationStateRef.current)) {
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

  useDictationUtteranceControls({
    dictationStateRef,
    activeSessionIdRef,
    clearingUtteranceRef,
    pauseRequestedDuringStartRef,
    sessionReadyRef,
    pauseCapture,
    resumeCapture,
    clearLiveAudio,
    setDictationState,
    setPartialTranscript,
    startDictation,
    stopDictation,
    enabled: Boolean(settings?.voice?.enabled && settings.voice.sttModel)
  })

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

  useDictationTranscriptListeners({
    activeSessionIdRef,
    clearingUtteranceRef,
    finalTranscriptReceivedRef,
    insertionTargetRef,
    insertedFinalTranscriptRef,
    intentionalTargetCancellationRef,
    erroredSessionIdsRef,
    dictationRunRef,
    dictationStateRef,
    stoppedSessionIdsRef,
    stoppedResolversRef,
    stopRequestedDuringStartRef,
    pauseRequestedDuringStartRef,
    sessionReadyRef,
    setPartialTranscript,
    setDictationState,
    stopCapture,
    discardBufferedAudio
  })

  return <DictationIndicator />
}
