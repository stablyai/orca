import type { MutableRefObject } from 'react'

export function cleanupAudioCaptureGraph(args: {
  trackLostCleanupRef: MutableRefObject<(() => void) | null>
  processorRef: MutableRefObject<ScriptProcessorNode | null>
  sourceRef: MutableRefObject<MediaStreamAudioSourceNode | null>
  contextRef: MutableRefObject<AudioContext | null>
  streamRef: MutableRefObject<MediaStream | null>
}): void {
  args.trackLostCleanupRef.current?.()
  args.trackLostCleanupRef.current = null
  args.processorRef.current?.disconnect()
  args.sourceRef.current?.disconnect()
  args.processorRef.current = null
  args.sourceRef.current = null
  if (args.contextRef.current?.state !== 'closed') {
    void args.contextRef.current?.close()
  }
  args.contextRef.current = null
  args.streamRef.current?.getTracks().forEach((track) => track.stop())
  args.streamRef.current = null
}

export async function flushDictationAudioBuffer(args: {
  generation: number
  bufferedAudioGenerationRef: MutableRefObject<number>
  bufferedAudioRef: MutableRefObject<
    { samples: Float32Array; sampleRate: number; sessionId: string }[]
  >
  bufferAudioRef: MutableRefObject<boolean>
  removeOldestBufferedAudioChunk: () => void
  resetBufferedAudio: () => void
}): Promise<void> {
  try {
    while (
      args.bufferedAudioGenerationRef.current === args.generation &&
      args.bufferedAudioRef.current.length > 0
    ) {
      const chunk = args.bufferedAudioRef.current[0]
      if (!chunk) {
        break
      }
      args.removeOldestBufferedAudioChunk()
      await window.api.speech.feedAudio(chunk.samples, chunk.sampleRate, chunk.sessionId)
    }
  } finally {
    if (args.bufferedAudioGenerationRef.current === args.generation) {
      args.bufferAudioRef.current = false
      args.resetBufferedAudio()
    }
  }
}
