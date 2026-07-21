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
import { DICTATION_CONTROL_EVENT, type DictationControlAction } from './dictation-control-events'
import { useDictationSpeechEvents } from './use-dictation-speech-events'
import {
  isDictationOutputControlEnabled,
  toDictationOutputControlSettings
} from '../../../../shared/dictation-output-settings'

export function DictationController() {
  const dictationState = useAppStore((s) => s.dictationState)
  const setDictationState = useAppStore((s) => s.setDictationState)
  const setPartialTranscript = useAppStore((s) => s.setPartialTranscript)
  const resetDictationMeter = useAppStore((s) => s.resetDictationMeter)
  const setDictationNotice = useAppStore((s) => s.setDictationNotice)
  const clearDictationNotice = useAppStore((s) => s.clearDictationNotice)
  const recordFeatureInteraction = useAppStore((s) => s.recordFeatureInteraction)
  const settings = useAppStore((s) => s.settings)
  const keybindings = useAppStore((s) => s.keybindings)
  const {
    start: startCapture,
    stop: stopCapture,
    flushBufferedAudio,
    discardBufferedAudio,
    getCapturedChunkCount,
    getRecoveryAudioChunks,
    clearRecoveryAudio
  } = useAudioCapture()

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
  const partialTranscriptRef = useRef('')
  const appliedOutputSessionIdsRef = useRef(new Set<string>())
  const restoredOutputSessionIdsRef = useRef(new Set<string>())

  const drainStoppedSession = useCallback((sessionId: string) => {
    void waitForStoppedSession(sessionId, stoppedSessionIdsRef, stoppedResolversRef)
  }, [])

  const applyDictationOutputControl = useCallback(
    async (sessionId: string) => {
      const outputSettings = toDictationOutputControlSettings(settings?.voice ?? {})
      if (!isDictationOutputControlEnabled(outputSettings)) {
        return
      }
      try {
        await window.api.dictationOutput.apply(sessionId, outputSettings)
        appliedOutputSessionIdsRef.current.add(sessionId)
        restoredOutputSessionIdsRef.current.delete(sessionId)
      } catch {
        // Best-effort output control must never block dictation startup.
      }
    },
    [settings?.voice]
  )

  const restoreDictationOutputControl = useCallback(async (sessionId: string) => {
    if (
      !appliedOutputSessionIdsRef.current.has(sessionId) ||
      restoredOutputSessionIdsRef.current.has(sessionId)
    ) {
      return
    }
    restoredOutputSessionIdsRef.current.add(sessionId)
    appliedOutputSessionIdsRef.current.delete(sessionId)
    try {
      await window.api.dictationOutput.restore(sessionId)
    } catch {
      // Restore is best-effort; the main process also owns idempotent cleanup.
    }
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
      await restoreDictationOutputControl(sessionId)
      const sessionErrored = erroredSessionIdsRef.current.delete(sessionId)
      if (!sessionErrored && !finalTranscriptReceivedRef.current && getCapturedChunkCount() > 0) {
        toast.message(
          translate(
            'auto.components.dictation.DictationController.5d2c3e7ae3',
            'No speech detected.'
          )
        )
        setDictationNotice({
          kind: 'info',
          message: translate(
            'auto.components.dictation.DictationController.5d2c3e7ae3',
            'No speech detected.'
          ),
          createdAt: Date.now()
        })
      }
      insertionTargetRef.current = null
      finalTranscriptReceivedRef.current = false
      insertedFinalTranscriptRef.current = ''
      partialTranscriptRef.current = ''
      clearRecoveryAudio()
      intentionalTargetCancellationRef.current = false
      stopRequestedDuringStartRef.current = false
      if (activeSessionIdRef.current === sessionId) {
        activeSessionIdRef.current = null
      }
      dictationStateRef.current = 'idle'
      setDictationState('idle')
      setPartialTranscript('')
    },
    [
      setDictationState,
      setPartialTranscript,
      stopCapture,
      getCapturedChunkCount,
      clearRecoveryAudio,
      restoreDictationOutputControl,
      setDictationNotice
    ]
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
    partialTranscriptRef.current = ''
    dictationRunRef.current = runId
    activeSessionIdRef.current = sessionId
    insertionTargetRef.current = captureInsertionTarget()
    stopRequestedDuringStartRef.current = false
    finalTranscriptReceivedRef.current = false
    erroredSessionIdsRef.current.clear()
    insertedFinalTranscriptRef.current = ''
    intentionalTargetCancellationRef.current = false
    resetDictationMeter()
    clearDictationNotice()
    dictationStateRef.current = 'starting'
    setDictationState('starting')

    let captureStarted = false

    try {
      await applyDictationOutputControl(sessionId)
      // Why: worker startup can take seconds after idle teardown. Capture first
      // and buffer locally so speech during "Starting..." is not discarded.
      await startCapture({ bufferAudio: true, sessionId })
      captureStarted = true
      if (stopRequestedDuringStartRef.current) {
        stopCapture({ preserveBufferedAudio: true })
      }
      if (dictationRunRef.current !== runId) {
        discardBufferedAudio()
        stopCapture()
        insertionTargetRef.current = null
        await restoreDictationOutputControl(sessionId)
        return
      }

      const customVocabulary = settings?.voice?.customVocabulary
      const hotwords =
        customVocabulary && customVocabulary.length > 0 ? customVocabulary : undefined
      await window.api.speech.startDictation(modelId, hotwords, sessionId)
      if (dictationRunRef.current !== runId) {
        discardBufferedAudio()
        insertionTargetRef.current = null
        stopCapture()
        await window.api.speech.stopDictation(sessionId).catch(() => undefined)
        drainStoppedSession(sessionId)
        await restoreDictationOutputControl(sessionId)
        return
      }

      await flushBufferedAudio()
      if (dictationRunRef.current !== runId) {
        discardBufferedAudio()
        insertionTargetRef.current = null
        stopCapture()
        await window.api.speech.stopDictation(sessionId).catch(() => undefined)
        drainStoppedSession(sessionId)
        await restoreDictationOutputControl(sessionId)
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
        await restoreDictationOutputControl(sessionId)
        return
      }
      await window.api.speech.stopDictation(sessionId).catch(() => undefined)
      drainStoppedSession(sessionId)
      if (captureStarted) {
        stopCapture()
      }
      discardBufferedAudio()
      await restoreDictationOutputControl(sessionId)
      const message = String(err)
      insertionTargetRef.current = null
      intentionalTargetCancellationRef.current = false
      stopRequestedDuringStartRef.current = false
      finalTranscriptReceivedRef.current = false
      erroredSessionIdsRef.current.clear()
      insertedFinalTranscriptRef.current = ''
      partialTranscriptRef.current = ''
      clearRecoveryAudio()
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
      setDictationNotice({
        kind: 'error',
        message: translate(
          'auto.components.dictation.DictationController.4e9cc6f8a1',
          'Dictation failed.'
        ),
        createdAt: Date.now()
      })
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
    resetDictationMeter,
    clearDictationNotice,
    clearRecoveryAudio,
    applyDictationOutputControl,
    restoreDictationOutputControl,
    setDictationNotice
  ])

  const stopDictation = useCallback(async () => {
    if (dictationStateRef.current === 'starting') {
      stopRequestedDuringStartRef.current = true
      dictationStateRef.current = 'stopping'
      setDictationState('stopping')
      stopCapture({ preserveBufferedAudio: true })
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
  }, [finishDictationSession, setDictationState, stopCapture])

  // Toggle mode: use IPC from main process (before-input-event intercepts
  // the keyDown so Cmd+E doesn't reach xterm or trigger system shortcuts).
  useEffect(() => {
    return () => {
      const sessionId = activeSessionIdRef.current
      if (sessionId) {
        void restoreDictationOutputControl(sessionId)
      }
    }
  }, [restoreDictationOutputControl])

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

  useDictationSpeechEvents({
    settings,
    dictationRunRef,
    activeSessionIdRef,
    insertionTargetRef,
    stoppedSessionIdsRef,
    stoppedResolversRef,
    stopRequestedDuringStartRef,
    finalTranscriptReceivedRef,
    erroredSessionIdsRef,
    intentionalTargetCancellationRef,
    insertedFinalTranscriptRef,
    partialTranscriptRef,
    dictationStateRef,
    setPartialTranscript,
    setDictationState,
    stopCapture,
    getRecoveryAudioChunks,
    clearRecoveryAudio,
    restoreDictationOutput: restoreDictationOutputControl,
    setDictationNotice
  })

  return <DictationIndicator />
}
