import { useRef, useCallback, useState } from 'react'
import { useAppStore } from '@/store'
import { useAudioCapture } from '@/hooks/use-audio-capture'
import { DictationIndicator } from './DictationIndicator'
import { captureInsertionTarget } from './dictation-insertion-target'
import { captureDictationContext } from './dictation-context'
import { dictationPillAnchorFor, type DictationPillAnchor } from './dictation-pill-anchor'
import {
  canRetryDictation,
  createDictationKeptRecording,
  type DictationKeptRecording
} from './dictation-kept-recording'
import { useDictationRetry } from './use-dictation-retry'
import { useDictationControls } from './use-dictation-controls'
import { useDictationQueuedSend } from './use-dictation-queued-send'
import { createDictationTranscriptDelivery } from './dictation-transcript-delivery'
import { createDictationStoppedSessions } from './dictation-stopped-sessions'
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
import { stopAfterSilenceSeconds } from '../../../../shared/dictation-silence-stop'
import { useDictationSpeechEvents } from './use-dictation-speech-events'
import { useDictationSpeechModelSetup } from './use-dictation-speech-model-setup'
import { shouldHoldForCleanup, useDictationCleanup } from './use-dictation-cleanup'
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
  const [stoppedSessions] = useState(createDictationStoppedSessions)
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
  const isIdle = useCallback(() => sessionRef.current.phase === 'idle', [])
  const { setupTarget, closeSetup, hasPendingStart, invalidatePendingStart, readyToRecord } =
    useDictationSpeechModelSetup(settings?.voice, isIdle, setPillAnchor)
  const queuedSend = useDictationQueuedSend(sessionRef, keptRef)
  const { clear: clearQueuedSend, release: releaseQueuedSend } = queuedSend
  const cleanup = useDictationCleanup(keptRef)
  const { land: landCleanup, interrupt: interruptCleanup } = cleanup

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
      await stoppedSessions.wait(sessionId)
      if (sessionRef.current.run !== run) {
        return
      }
      if (!sessionRef.current.heardFinalText && getCapturedChunkCount() > 0) {
        showNoSpeechDetectedToast()
      }
      beforeEnd?.()
      await landCleanup()
      await releaseQueuedSend(run)
      if (sessionRef.current.run === run) {
        dispatch({ type: 'ended' })
      }
    },
    [
      dispatch,
      finishCapture,
      getCapturedChunkCount,
      stoppedSessions,
      releaseQueuedSend,
      landCleanup
    ]
  )

  /** The error pill when the recording can be retried; otherwise the toast, as nothing is left to retry. */
  const showFailure = useCallback(
    (kind: DictationFailureKind | null, showToast: () => void) => {
      interruptCleanup()
      dispatch({ type: 'fail' })
      if (kind && canRetryDictation(keptRef.current)) {
        setFailure(kind)
        return
      }
      showToast()
      dispatch({ type: 'ended' })
    },
    [dispatch, interruptCleanup]
  )

  // Words that already landed stay; the engine drops the rest instead of transcribing it.
  const cancelDictation = useCallback(() => {
    // ✕ while cleaning up skips cleanup; the words then land as heard.
    if (interruptCleanup()) {
      return
    }
    invalidatePendingStart()
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
    void stoppedSessions.wait(previous.sessionId)
  }, [dispatch, stopCapture, stoppedSessions, invalidatePendingStart, interruptCleanup])

  const stopDictation = useCallback(async () => {
    invalidatePendingStart()
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
  }, [dispatch, finishCapture, finishDictationSession, invalidatePendingStart])

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

    if (!(await readyToRecord(settings.voice)) || !canStartDictation(sessionRef.current.phase)) {
      return
    }

    const { run, sessionId } = dispatch({ type: 'start' })
    if (sessionId === null) {
      return
    }
    const isCurrent = (): boolean => sessionRef.current.run === run
    const insertionTarget = captureInsertionTarget()
    const deliver = createDictationTranscriptDelivery(shouldHoldForCleanup())
    deliverRef.current = (text) => deliver(text, insertionTarget)
    const context = captureDictationContext()
    const kept = createDictationKeptRecording(insertionTarget, deliver, context)
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
        void stoppedSessions.wait(sessionId)
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

      await window.api.speech.startDictation(modelId, context, sessionId)
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
    stoppedSessions,
    recordFeatureInteraction,
    showFailure,
    readyToRecord
  ])

  const retryDictation = useDictationRetry({
    modelId: settings?.voice?.sttModel,
    sessionRef,
    keptRef,
    deliverRef,
    dispatch,
    finish: finishDictationSession,
    showFailure
  })

  const toggleDictation = useCallback(() => {
    // A second press while the model check runs takes the first one back.
    if (hasPendingStart()) {
      invalidatePendingStart()
      return
    }
    if (isDictationUnderway(sessionRef.current.phase)) {
      void stopDictation()
    } else {
      void startDictation()
    }
  }, [startDictation, stopDictation, hasPendingStart, invalidatePendingStart])

  useDictationControls(settings?.voice, dictationState, {
    start: () => void startDictation(),
    stop: () => void stopDictation(),
    cancel: cancelDictation,
    toggle: toggleDictation,
    retry: () => void retryDictation(),
    enterQueues: (event) => queuedSend.queueTerminalEnter(event.target),
    // The error pill leaves Esc to Settings and dialogs; only its ✕ discards the recording.
    escCancels: () => hasPendingStart() || !canStartDictation(sessionRef.current.phase)
  })

  const { isHolding } = useHoldDictationGesture({
    canStartDictation: () => canStartDictation(sessionRef.current.phase),
    isDictationUnderway: () => isDictationUnderway(sessionRef.current.phase),
    keybindings,
    settings,
    startDictation,
    stopDictation
  })

  useDictationSilenceStop(
    dictationState === 'listening',
    settings?.voice?.dictationMode,
    stopAfterSilenceSeconds(settings?.voice),
    getLastSpeechAt,
    isHolding,
    () => void stopDictation()
  )

  useDictationSpeechEvents({
    currentSessionId: () => sessionRef.current.sessionId,
    onLiveText: setLiveText,
    onFinal: (text) => {
      dispatch({ type: 'final-text' })
      deliverRef.current?.(text)
    },
    onStopped: (sessionId) => stoppedSessions.record(sessionId),
    onError: (sessionId, error) => {
      const { run } = dispatch({ type: 'abandon' })
      stopCapture()
      discardBufferedAudio()
      void (async () => {
        await window.api.speech.stopDictation(sessionId).catch(() => undefined)
        await stoppedSessions.wait(sessionId)
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
      cleanup={cleanup}
      setup={setupTarget}
      onSetupClose={closeSetup}
    />
  )
}
