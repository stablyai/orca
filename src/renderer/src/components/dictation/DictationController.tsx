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
import { getShortcutPlatform } from '@/lib/shortcut-platform'
import { formatFinalTranscriptSegment } from './dictation-final-segments'
import { recordStoppedSession, waitForStoppedSession } from './dictation-stopped-sessions'
import { keybindingMatchesAction } from '../../../../shared/keybindings'

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
  const intentionalTargetCancellationRef = useRef(false)
  const insertedFinalTranscriptRef = useRef('')

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
      if (!finalTranscriptReceivedRef.current && getCapturedChunkCount() > 0) {
        toast.message('No speech detected.')
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
          label: 'Open Settings',
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
    finalTranscriptReceivedRef.current = false
    insertedFinalTranscriptRef.current = ''
    intentionalTargetCancellationRef.current = false
    dictationStateRef.current = 'starting'
    setDictationState('starting')

    let captureStarted = false

    try {
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
      intentionalTargetCancellationRef.current = false
      stopRequestedDuringStartRef.current = false
      finalTranscriptReceivedRef.current = false
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
      if (message.includes('Permission') || message.includes('NotAllowed')) {
        toast.error('Microphone access denied. Grant access in system settings, then restart Orca.')
      } else if (message.includes('not ready')) {
        toast('Speech model not ready. Download it in Settings > Voice.')
      } else if (message.includes('Unknown model')) {
        toast('Selected model is no longer available. Please choose another in Settings > Voice.', {
          action: {
            label: 'Open Settings',
            onClick: () => {
              useAppStore.getState().openSettingsTarget({ pane: 'voice', repoId: null })
              useAppStore.getState().openSettingsPage()
            }
          }
        })
      } else {
        toast.error(`Dictation failed: ${message}`)
      }
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

  // Why: hold mode uses renderer-side DOM events instead of the IPC path
  // (before-input-event). When before-input-event calls preventDefault()
  // on the keyDown, Electron suppresses ALL subsequent DOM events for that
  // key combo — including the keyUp we need to detect release. By handling
  // Cmd+E entirely in the renderer, both keydown and keyup fire normally.
  // On macOS, Cmd+E doesn't produce a terminal control character (unlike
  // Ctrl+E on Linux), so letting it through to xterm is harmless.
  useEffect(() => {
    const mode = settings?.voice?.dictationMode ?? 'toggle'
    if (mode !== 'hold') {
      return
    }

    const handleKeyDown = (e: KeyboardEvent): void => {
      if (keybindingMatchesAction('voice.dictation', e, getShortcutPlatform(), keybindings)) {
        if (!settings?.voice?.enabled || !settings.voice.sttModel) {
          return
        }
        e.preventDefault()
        e.stopPropagation()
        holdGestureActiveRef.current = true
        if (dictationStateRef.current === 'idle') {
          void startDictation()
        }
      }
    }

    const handleKeyUp = (): void => {
      if (!holdGestureActiveRef.current) {
        return
      }
      if (dictationStateRef.current === 'idle' || dictationStateRef.current === 'stopping') {
        holdGestureActiveRef.current = false
        return
      }
      holdGestureActiveRef.current = false
      void stopDictation()
    }

    const handleBlur = (): void => {
      if (!holdGestureActiveRef.current) {
        return
      }
      holdGestureActiveRef.current = false
      if (dictationStateRef.current !== 'idle' && dictationStateRef.current !== 'stopping') {
        insertionTargetRef.current = null
        intentionalTargetCancellationRef.current = true
        void stopDictation()
      }
    }

    const handleVisibilityChange = (): void => {
      if (document.visibilityState !== 'visible') {
        handleBlur()
      }
    }

    window.addEventListener('keydown', handleKeyDown, true)
    window.addEventListener('keyup', handleKeyUp, true)
    window.addEventListener('blur', handleBlur)
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => {
      handleBlur()
      window.removeEventListener('keydown', handleKeyDown, true)
      window.removeEventListener('keyup', handleKeyUp, true)
      window.removeEventListener('blur', handleBlur)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [
    settings?.voice?.dictationMode,
    settings?.voice?.enabled,
    settings?.voice?.sttModel,
    keybindings,
    startDictation,
    stopDictation
  ])

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
        toast.message('Dictation finished, but no text field was focused.')
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
      dictationRunRef.current += 1
      activeSessionIdRef.current = null
      toast.error(`Speech error: ${data.error}`)
      dictationStateRef.current = 'stopping'
      setDictationState('stopping')
      stopCapture()
      discardBufferedAudio()
      void (async () => {
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
  }, [setPartialTranscript, setDictationState, stopCapture, discardBufferedAudio])

  return <DictationIndicator />
}
