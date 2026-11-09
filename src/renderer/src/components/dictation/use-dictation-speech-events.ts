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
  const transcriptRef = useRef<{ sessionId: string; transcript: DictationTranscript } | null>(null)
  const isCurrent = useEffectEvent((sessionId: string) => sessionId === handlers.currentSessionId())
  const onText = useEffectEvent(
    (sessionId: string, event: { type: 'partial' | 'final'; text: string }) => {
      if (transcriptRef.current?.sessionId !== sessionId) {
        transcriptRef.current = { sessionId, transcript: new DictationTranscript() }
      }
      const { transcript } = transcriptRef.current
      transcript.accept(event)
      const { committed, tentative } = transcript.snapshot()
      handlers.onLiveText({ committed, tentative })
    }
  )
  const onFinal = useEffectEvent(handlers.onFinal)
  const onStopped = useEffectEvent(handlers.onStopped)
  const onError = useEffectEvent(handlers.onError)

  useEffect(() => {
    const cleanups = [
      window.api.speech.onPartialTranscript((data) => {
        if (isCurrent(data.sessionId)) {
          onText(data.sessionId, { type: 'partial', text: data.text })
        }
      }),
      window.api.speech.onFinalTranscript((data) => {
        if (data.text && isCurrent(data.sessionId)) {
          onText(data.sessionId, { type: 'final', text: data.text })
          onFinal(data.text)
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
