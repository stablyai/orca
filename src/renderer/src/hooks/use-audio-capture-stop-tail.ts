import { useCallback, useRef, type MutableRefObject } from 'react'

export type StopAudioCaptureOptions = {
  preserveBufferedAudio?: boolean
}

// Stop lands on the last syllable while the processor still holds up to one unread 85 ms buffer.
const STOP_TAIL_MS = 250

/** Keep capturing briefly after a user stop so the word being finished reaches the recognizer. */
export function useAudioCaptureStopTail(
  isCapturingRef: MutableRefObject<boolean>,
  startRequestRef: MutableRefObject<number>,
  stop: (options?: StopAudioCaptureOptions) => void
): (options?: StopAudioCaptureOptions) => Promise<void> {
  const pendingRef = useRef<{ startRequest: number; finished: Promise<void> } | null>(null)

  return useCallback(
    (options: StopAudioCaptureOptions = {}) => {
      const startRequest = startRequestRef.current
      if (!isCapturingRef.current) {
        stop(options)
        return Promise.resolve()
      }
      if (pendingRef.current?.startRequest === startRequest) {
        return pendingRef.current.finished
      }
      const finished = new Promise<void>((resolve) => {
        setTimeout(() => {
          // An immediate stop or a new capture in the meantime already owns teardown.
          if (startRequestRef.current === startRequest) {
            stop(options)
          }
          resolve()
        }, STOP_TAIL_MS)
      })
      pendingRef.current = { startRequest, finished }
      return finished
    },
    [isCapturingRef, startRequestRef, stop]
  )
}
