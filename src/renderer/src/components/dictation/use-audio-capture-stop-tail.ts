import { useCallback, type MutableRefObject } from 'react'

export type StopCaptureOptions = {
  preserveBufferedAudio?: boolean
}

// Stop lands on the last syllable while the capture worklet still holds up to one unsent 100 ms frame.
const STOP_TAIL_MS = 250

/** Keep capturing briefly after a user stop so the word being finished reaches the recognizer. */
export function useAudioCaptureStopTail(
  isCapturingRef: MutableRefObject<boolean>,
  startRequestRef: MutableRefObject<number>,
  stop: (options?: StopCaptureOptions) => void
): (options?: StopCaptureOptions) => Promise<void> {
  return useCallback(
    (options: StopCaptureOptions = {}) => {
      if (!isCapturingRef.current) {
        stop(options)
        return Promise.resolve()
      }
      const startRequest = startRequestRef.current
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          // An earlier tail, an immediate stop or a new capture already owns teardown.
          if (startRequestRef.current === startRequest) {
            stop(options)
          }
          resolve()
        }, STOP_TAIL_MS)
      })
    },
    [isCapturingRef, startRequestRef, stop]
  )
}
