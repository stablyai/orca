import { useCallback, useRef } from 'react'

export type AudioCaptureChunk = {
  samples: Float32Array
  sampleRate: number
  sessionId: string
}

const MAX_RECOVERY_AUDIO_SECONDS = 10 * 60
const MAX_RECOVERY_AUDIO_BYTES = 64 * 1024 * 1024

export function useAudioRecoveryBuffer() {
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

  const clear = useCallback(() => {
    chunksRef.current = []
    bytesRef.current = 0
    secondsRef.current = 0
  }, [])

  const append = useCallback(
    (chunk: AudioCaptureChunk) => {
      chunksRef.current.push(chunk)
      bytesRef.current += chunk.samples.byteLength
      secondsRef.current += chunk.samples.length / chunk.sampleRate

      while (
        chunksRef.current.length > 0 &&
        (bytesRef.current > MAX_RECOVERY_AUDIO_BYTES ||
          secondsRef.current > MAX_RECOVERY_AUDIO_SECONDS)
      ) {
        removeOldest()
      }
    },
    [removeOldest]
  )

  const getChunks = useCallback(
    () =>
      chunksRef.current.map((chunk) => ({
        ...chunk,
        samples: new Float32Array(chunk.samples)
      })),
    []
  )

  return { append, clear, getChunks }
}
