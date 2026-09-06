import { useCallback, useRef, type MutableRefObject } from 'react'

export function useCapturePause(
  resetMeter: () => void,
  resetBufferedAudio: () => void,
  capturedChunkCountRef: MutableRefObject<number>
) {
  const pausedRef = useRef(false)

  const pause = useCallback(() => {
    pausedRef.current = true
    resetMeter()
  }, [resetMeter])

  const resume = useCallback(() => {
    pausedRef.current = false
  }, [])

  const resetPause = useCallback(() => {
    pausedRef.current = false
  }, [])

  const clearLiveAudio = useCallback(() => {
    resetBufferedAudio()
    capturedChunkCountRef.current = 0
    resetMeter()
  }, [capturedChunkCountRef, resetBufferedAudio, resetMeter])

  return { pausedRef, pause, resume, resetPause, clearLiveAudio }
}
