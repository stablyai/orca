import { useCallback, useEffect, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import { registerDictationConversationTarget } from '../dictation/dictation-conversation-target'
import { dispatchDictationControl } from '../dictation/dictation-control-events'
import { resolveRendererUiLocale } from '../../../../shared/ui-locale'
import { supportsVoiceConversation } from '../../../../shared/sts-voice-input-model'

export function useNativeChatVoiceInput(args: {
  active: boolean
  autoSend: boolean
  onReady: (text: string) => void
  onBeforeStart: () => void
  onTranscript?: (text: string, final: boolean) => void
  onAudio?: (samples: Float32Array, sampleRate: number) => void
  onCaptureEnded?: () => void
}) {
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const [draft, setDraftState] = useState('')
  const [partial, setPartial] = useState('')
  const [owned, setOwned] = useState(false)
  const [error, setError] = useState('')
  const owns = useRef(false)
  const cancelled = useRef(false)
  const draftRef = useRef('')
  const latest = useRef(args)
  latest.current = args
  const state = useAppStore((store) => store.dictationState)
  const settings = useAppStore((store) => store.settings?.voice)
  const language = useAppStore(
    (store) =>
      store.settings?.voice?.conversationLanguage ??
      resolveRendererUiLocale(store.settings?.uiLanguage ?? 'system')
  )
  const ready = supportsVoiceConversation(settings, language)
  const setDraft = useCallback((text: string) => {
    draftRef.current = text
    setDraftState(text)
  }, [])

  const stop = useCallback(() => {
    if (owns.current) {
      dispatchDictationControl('stop')
    }
  }, [])

  const cancel = useCallback(() => {
    cancelled.current = true
    stop()
  }, [stop])

  useEffect(() => {
    const element = inputRef.current
    if (!element || !args.active) {
      return
    }
    const unregister = registerDictationConversationTarget(element, {
      onAudio: (samples, rate) => {
        if (owns.current && !cancelled.current) {
          latest.current.onAudio?.(samples, rate)
        }
      },
      acceptsCapture: () => owns.current,
      onPartial: (text) => {
        if (owns.current) {
          setPartial(text)
          if (!cancelled.current) {
            latest.current.onTranscript?.(text, false)
          }
        }
      },
      onFinal: (text) => {
        if (!owns.current) {
          return
        }
        setPartial('')
        if (latest.current.onTranscript) {
          if (!cancelled.current) {
            latest.current.onTranscript(text, true)
          }
          return
        }
        setDraft(draftRef.current + text)
        if (latest.current.autoSend) {
          dispatchDictationControl('stop')
        }
      },
      onStopped: () => {
        if (!owns.current) {
          return
        }
        owns.current = false
        setOwned(false)
        setPartial('')
        if (!cancelled.current) {
          latest.current.onCaptureEnded?.()
        }
        if (
          !cancelled.current &&
          latest.current.active &&
          latest.current.autoSend &&
          draftRef.current.trim()
        ) {
          latest.current.onReady(draftRef.current)
        }
      },
      onError: (message) => {
        owns.current = false
        setOwned(false)
        setPartial('')
        setError(message)
      }
    })
    return () => {
      unregister()
      stop()
      owns.current = false
      setOwned(false)
      setPartial('')
    }
  }, [args.active, setDraft, stop])

  useEffect(() => {
    if (owned && state === 'idle' && owns.current) {
      owns.current = false
      setOwned(false)
      setPartial('')
    }
  }, [owned, state])

  const start = useCallback(() => {
    if (!latest.current.active || !ready || useAppStore.getState().dictationState !== 'idle') {
      return false
    }
    const element = inputRef.current
    if (!element) {
      return false
    }
    latest.current.onBeforeStart()
    if (!element.isConnected) {
      return false
    }
    owns.current = true
    cancelled.current = false
    setOwned(true)
    setError('')
    dispatchDictationControl('start', element)
    return true
  }, [ready])

  return { inputRef, draft, setDraft, partial, owned, state, ready, error, start, stop, cancel }
}
