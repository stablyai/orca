import { useEffect, useEffectEvent } from 'react'

type DictationSpeechEventHandlers = {
  /** Text events are dropped unless they belong to this session. */
  currentSessionId: () => string | null
  onPartial: (text: string) => void
  onFinal: (text: string) => void
  onStopped: (sessionId: string) => void
  onError: (sessionId: string, error: string) => void
}

export function useDictationSpeechEvents(handlers: DictationSpeechEventHandlers): void {
  const isCurrent = useEffectEvent((sessionId: string) => sessionId === handlers.currentSessionId())
  const onPartial = useEffectEvent(handlers.onPartial)
  const onFinal = useEffectEvent(handlers.onFinal)
  const onStopped = useEffectEvent(handlers.onStopped)
  const onError = useEffectEvent(handlers.onError)

  useEffect(() => {
    const cleanups = [
      window.api.speech.onPartialTranscript((data) => {
        if (isCurrent(data.sessionId)) {
          onPartial(data.text)
        }
      }),
      window.api.speech.onFinalTranscript((data) => {
        if (data.text && isCurrent(data.sessionId)) {
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
