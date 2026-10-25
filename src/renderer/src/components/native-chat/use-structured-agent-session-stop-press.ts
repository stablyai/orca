import { useCallback, useRef, useState } from 'react'

/** Show Stopping immediately until this request settles; afterward use host stopping state. Keep the press local to presentation. */
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
