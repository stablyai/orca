import { useCallback, useRef } from 'react'
import type { AudioCaptureChunk } from './use-audio-recovery-buffer'

const MAX_BUFFERED_AUDIO_SECONDS = 30
const MAX_BUFFERED_AUDIO_BYTES = 8 * 1024 * 1024

export function useAudioStartupBuffer() {
  const enabledRef = useRef(false)
  const generationRef = useRef(0)
  const chunksRef = useRef<AudioCaptureChunk[]>([])
  const bytesRef = useRef(0)
  const secondsRef = useRef(0)

  const removeOldest = useCallback(() => {
    const chunk = chunksRef.current.shift()
    if (!chunk) {
      return
    }
    bytesRef.current -= chunk.samples.byteLength
    secondsRef.current -= chunk.samples.length / chunk.sampleRate
  }, [])

  const reset = useCallback(() => {
    generationRef.current += 1
    chunksRef.current = []
    bytesRef.current = 0
    secondsRef.current = 0
  }, [])

  const setEnabled = useCallback((enabled: boolean) => {
    enabledRef.current = enabled
  }, [])

  const append = useCallback(
    (chunk: AudioCaptureChunk) => {
      chunksRef.current.push(chunk)
      bytesRef.current += chunk.samples.byteLength
      secondsRef.current += chunk.samples.length / chunk.sampleRate

      while (
        chunksRef.current.length > 0 &&
        (bytesRef.current > MAX_BUFFERED_AUDIO_BYTES ||
          secondsRef.current > MAX_BUFFERED_AUDIO_SECONDS)
      ) {
        removeOldest()
      }
    },
    [removeOldest]
  )

  const flush = useCallback(async () => {
    const flushGeneration = generationRef.current
    try {
      while (generationRef.current === flushGeneration && chunksRef.current.length > 0) {
        const chunk = chunksRef.current[0]
        if (!chunk) {
          break
        }
        removeOldest()
        await window.api.speech.feedAudio(chunk.samples, chunk.sampleRate, chunk.sessionId)
      }
    } finally {
      if (generationRef.current === flushGeneration) {
        enabledRef.current = false
        reset()
      }
    }
  }, [removeOldest, reset])

  return {
    append,
    flush,
    isEnabled: () => enabledRef.current,
    reset,
    setEnabled
  }
}
