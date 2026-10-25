import { useCallback, useRef, useState } from 'react'

/**
 * The person's own Stop press, read as "Stopping…" until its request answers, so the control
 * flips on click while the host's Stop event is still on its way. Presentation only: never
 * stored or sent. Once it answers, the host's own `stopping` is what the chat shows.
 */
export function useStructuredAgentSessionStopPress(sessionId: string): {
  pressed: boolean
  track: <T>(stop: () => Promise<T>) => Promise<T>
} {
  const [press, setPress] = useState<{ sessionId: string; token: symbol } | null>(null)
  const latest = useRef<symbol | null>(null)
  const track = useCallback(
    async <T>(stop: () => Promise<T>): Promise<T> => {
      const token = Symbol('stop-press')
      latest.current = token
      setPress({ sessionId, token })
      try {
        return await stop()
      } finally {
        // Answered or failed alike: a failed request's notice is the existing one.
        if (latest.current === token) {
          latest.current = null
          setPress(null)
        }
      }
    },
    [sessionId]
  )
  return { pressed: press?.sessionId === sessionId, track }
}
