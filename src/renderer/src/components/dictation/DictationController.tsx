import { useRef, useCallback, useState } from 'react'
import { useAppStore } from '@/store'
import { useAudioCapture } from '@/hooks/use-audio-capture'
import { DictationIndicator } from './DictationIndicator'
import { captureInsertionTarget } from './dictation-insertion-target'
import { dictationPillAnchorFor, type DictationPillAnchor } from './dictation-pill-anchor'
import {
  canRetryDictation,
  createDictationKeptRecording,
  transcribeKeptRecording,
  type DictationKeptRecording
} from './dictation-kept-recording'
import { useDictationControls } from './use-dictation-controls'
import { useDictationQueuedSend } from './use-dictation-queued-send'
import { createDictationTranscriptDelivery } from './dictation-transcript-delivery'
import { recordStoppedSession, waitForStoppedSession } from './dictation-stopped-sessions'
import {
  showDictationDisabledToast,
  showDictationNoModelToast,
  showCloudLimitToast,
  dictationStartFailureKind,
  showDictationStartErrorToast,
  type DictationFailureKind,
  showMicrophoneDisconnectedToast,
  showMicrophoneFallbackToast,
  showNoSpeechDetectedToast,
  showSpeechErrorToast
} from './dictation-toasts'
import { useHoldDictationGesture } from './use-hold-dictation-gesture'
import { publishDictationMeter } from './dictation-meter-store'
import { useDictationSilenceStop } from './use-dictation-silence-stop'
import { useDictationSpeechEvents } from './use-dictation-speech-events'
import { NO_DICTATION_LIVE_TEXT } from '@/store/slices/dictation/dictation'
import {
  canStartDictation,
  initialDictationSession,
  isDictationUnderway,
  transitionDictationSession,
  type DictationSession,
  type DictationSessionEvent
} from '../../../../shared/dictation-session-machine'

export function DictationController() {
  const dictationState = useAppStore((s) => s.dictationState)
  const setDictationState = useAppStore((s) => s.setDictationState)
  const setLiveText = useAppStore((s) => s.setLiveText)
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
  // Holds the target pane only while the pill shows, so a closed pane isn't kept alive.
  const [pillAnchor, setPillAnchor] = useState<DictationPillAnchor | null>(null)
  // The session's audio, kept until it lands, is retried, dismissed or replaced.
  const keptRef = useRef<DictationKeptRecording | null>(null)
  const [failure, setFailure] = useState<DictationFailureKind | null>(null)
  // A new recording gets a fresh pill (timer and all); a retry keeps the one it failed in.
  const [recordingKey, setRecordingKey] = useState(0)
  const queuedSend = useDictationQueuedSend(sessionRef, keptRef)
  const { clear: clearQueuedSend, release: releaseQueuedSend } = queuedSend

  const dispatch = useCallback(
    (event: DictationSessionEvent): DictationSession => {
      const previous = sessionRef.current
      const next = transitionDictationSession(previous, event)
      sessionRef.current = next
      if (next.sessionId === null) {
        deliverRef.current = null
      }
      if (next.sessionId !== previous.sessionId) {
        setLiveText(NO_DICTATION_LIVE_TEXT)
      }
      if (next.phase !== previous.phase) {
        setDictationState(next.phase)
        if (next.phase === 'idle') {
          setPillAnchor(null)
          keptRef.current = null
        }
        if (next.phase === 'idle' || next.phase === 'error') {
          clearQueuedSend()
        }
        if (next.phase !== 'error') {
          setFailure(null)
        }
      }
      return next
    },
    [setDictationState, setLiveText, clearQueuedSend]
  )

  const drainStoppedSession = useCallback((sessionId: string) => {
    void waitForStoppedSession(sessionId, stoppedSessionIdsRef, stoppedResolversRef)
  }, [])

  const finishDictationSession = useCallback(
    async ({ run, sessionId }: DictationSession, beforeEnd?: () => void) => {
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
        showNoSpeechDetectedToast()
      }
      beforeEnd?.()
      await releaseQueuedSend(run)
      if (sessionRef.current.run === run) {
        dispatch({ type: 'ended' })
      }
    },
    [dispatch, finishCapture, getCapturedChunkCount, releaseQueuedSend]
  )

  /** The error pill when the recording can be retried; otherwise the toast, as nothing is left to retry. */
  const showFailure = useCallback(
    (kind: DictationFailureKind | null, showToast: () => void) => {
      dispatch({ type: 'fail' })
      if (kind && canRetryDictation(keptRef.current)) {
        setFailure(kind)
        return
      }
      showToast()
      dispatch({ type: 'ended' })
    },
    [dispatch]
  )

  // Words that already landed stay; the engine drops the rest instead of transcribing it.
  const cancelDictation = useCallback(() => {
    if (sessionRef.current.phase === 'error') {
      dispatch({ type: 'ended' })
      return
    }
    const previous = sessionRef.current
    if (dispatch({ type: 'cancel' }) === previous || previous.sessionId === null) {
      return
    }
    stopCapture()
    void window.api.speech.cancelDictation(previous.sessionId).catch(() => undefined)
    drainStoppedSession(previous.sessionId)
  }, [dispatch, stopCapture, drainStoppedSession])

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
    const kept = createDictationKeptRecording(insertionTarget, deliver)
    keptRef.current = kept
    setRecordingKey((key) => key + 1)
    setCaptureLive(false)
    setPillAnchor(dictationPillAnchorFor(insertionTarget))

    // A stop that arrived while starting is still this run's stop.
    const stopQueued = (): boolean => isCurrent() && sessionRef.current.phase === 'stopping'
    const releaseStart = async (engineStarted: boolean, captureStarted = true): Promise<void> => {
      discardBufferedAudio()
      if (captureStarted) {
        stopCapture()
      }
      if (engineStarted) {
        await window.api.speech.cancelDictation(sessionId).catch(() => undefined)
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
        onFrame: kept.keep,
        onCaptureLost: () => {
          if (isCurrent()) {
            showMicrophoneDisconnectedToast()
            void stopDictation()
          }
        },
        onAudioLimitReached: () => {
          kept.reachedHostLimit()
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
      showFailure(dictationStartFailureKind(message), () => showDictationStartErrorToast(message))
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
    recordFeatureInteraction,
    showFailure
  ])

  // Sends the failed session's recording through the speech host again, into the same place.
  const retryDictation = useCallback(async () => {
    const kept = keptRef.current
    const modelId = settings?.voice?.sttModel
    if (sessionRef.current.phase !== 'error' || !modelId || !kept || !canRetryDictation(kept)) {
      return
    }
    const { run, sessionId } = dispatch({ type: 'retry' })
    if (sessionId === null) {
      return
    }
    await transcribeKeptRecording({
      recording: kept,
      modelId,
      sessionId,
      isCurrent: () => sessionRef.current.run === run,
      routeFinals: (sink) => {
        deliverRef.current = sink
      },
      finish: (beforeEnd) => finishDictationSession(sessionRef.current, beforeEnd),
      fail: (message) =>
        showFailure(dictationStartFailureKind(message) ?? 'transcribe', () =>
          showDictationStartErrorToast(message)
        )
    })
  }, [settings, dispatch, finishDictationSession, showFailure])

  const toggleDictation = useCallback(() => {
    if (isDictationUnderway(sessionRef.current.phase)) {
      void stopDictation()
    } else {
      void startDictation()
    }
  }, [startDictation, stopDictation])

  useDictationControls(settings?.voice, dictationState, {
    start: () => void startDictation(),
    stop: () => void stopDictation(),
    cancel: cancelDictation,
    toggle: toggleDictation,
    retry: () => void retryDictation(),
    enterQueues: (event) => queuedSend.queueTerminalEnter(event.target),
    // The error pill leaves Esc to Settings and dialogs; only its ✕ discards the recording.
    escCancels: () =>
      isDictationUnderway(sessionRef.current.phase) || sessionRef.current.phase === 'stopping'
  })

  useDictationSilenceStop(
    dictationState === 'listening',
    settings?.voice?.dictationMode,
    getLastSpeechAt,
    () => void stopDictation()
  )

  useHoldDictationGesture({
    canStartDictation: () => canStartDictation(sessionRef.current.phase),
    isDictationUnderway: () => isDictationUnderway(sessionRef.current.phase),
    keybindings,
    settings,
    startDictation,
    stopDictation
  })

  useDictationSpeechEvents({
    currentSessionId: () => sessionRef.current.sessionId,
    onLiveText: setLiveText,
    onFinal: (text) => {
      dispatch({ type: 'final-text' })
      deliverRef.current?.(text)
    },
    onStopped: (sessionId) =>
      recordStoppedSession(sessionId, stoppedSessionIdsRef, stoppedResolversRef),
    onError: (sessionId, error) => {
      const { run } = dispatch({ type: 'abandon' })
      stopCapture()
      discardBufferedAudio()
      void (async () => {
        await window.api.speech.stopDictation(sessionId).catch(() => undefined)
        await waitForStoppedSession(sessionId, stoppedSessionIdsRef, stoppedResolversRef)
        if (sessionRef.current.run !== run) {
          return
        }
        showFailure('transcribe', () => showSpeechErrorToast(error))
      })()
    }
  })

  return (
    <DictationIndicator
      key={recordingKey}
      captureLive={captureLive}
      anchor={pillAnchor}
      failure={failure}
      queued={queuedSend.queuedKind}
    />
  )
}
