import { useEffect, useEffectEvent, useRef } from 'react'
import { DictationTranscript } from '../../../../shared/dictation-transcript'
import type { DictationLiveText } from '@/store/slices/dictation/dictation'

type DictationSpeechEventHandlers = {
  /** Text events are dropped unless they belong to this session. */
  currentSessionId: () => string | null
  /** The session's words so far, after every partial or final. */
  onLiveText: (text: DictationLiveText) => void
  onFinal: (text: string) => void
  onStopped: (sessionId: string) => void
  onError: (sessionId: string, error: string) => void
}

export function useDictationSpeechEvents(handlers: DictationSpeechEventHandlers): void {
  const liveRef = useRef<{
    sessionId: string
    transcript: DictationTranscript
    speechPending: boolean
  } | null>(null)
  const isCurrent = useEffectEvent((sessionId: string) => sessionId === handlers.currentSessionId())
  const onLiveEvent = useEffectEvent(
    (
      sessionId: string,
      event: { type: 'partial' | 'final'; text: string } | { type: 'pending'; pending: boolean }
    ) => {
      if (liveRef.current?.sessionId !== sessionId) {
        liveRef.current = { sessionId, transcript: new DictationTranscript(), speechPending: false }
      }
      const live = liveRef.current
      if (event.type === 'pending') {
        live.speechPending = event.pending
      } else {
        live.transcript.accept(event)
      }
      const { committed, tentative } = live.transcript.snapshot()
      handlers.onLiveText({ committed, tentative, speechPending: live.speechPending })
    }
  )
  const onFinal = useEffectEvent(handlers.onFinal)
  const onStopped = useEffectEvent(handlers.onStopped)
  const onError = useEffectEvent(handlers.onError)

  useEffect(() => {
    const cleanups = [
      window.api.speech.onPartialTranscript((data) => {
        if (isCurrent(data.sessionId)) {
          onLiveEvent(data.sessionId, { type: 'partial', text: data.text })
        }
      }),
      window.api.speech.onFinalTranscript((data) => {
        if (data.text && isCurrent(data.sessionId)) {
          onLiveEvent(data.sessionId, { type: 'final', text: data.text })
          onFinal(data.text)
        }
      }),
      window.api.speech.onSpeechPending((data) => {
        if (isCurrent(data.sessionId)) {
          onLiveEvent(data.sessionId, { type: 'pending', pending: data.pending })
        }
      }),
      window.api.speech.onStopped((data) => onStopped(data.sessionId)),
      window.api.speech.onError((data) => {
        if (isCurrent(data.sessionId)) {
          onError(data.sessionId, data.error)
        }
      })
    ]
    return () => cleanups.forEach((cleanup) => cleanup())
  }, [])
}
