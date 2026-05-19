import { useRef, useCallback } from 'react'

type BufferedAudioChunk = {
  samples: Float32Array
  sampleRate: number
  sessionId: string
}

type StartAudioCaptureOptions = {
  bufferAudio?: boolean
  sessionId?: string
}

type StopAudioCaptureOptions = {
  preserveBufferedAudio?: boolean
}

const MAX_BUFFERED_AUDIO_SECONDS = 30
const MAX_BUFFERED_AUDIO_BYTES = 8 * 1024 * 1024

export function useAudioCapture() {
  const streamRef = useRef<MediaStream | null>(null)
  const contextRef = useRef<AudioContext | null>(null)
  const processorRef = useRef<ScriptProcessorNode | null>(null)
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null)
  const isCapturingRef = useRef(false)
  const startRequestRef = useRef(0)
  const bufferAudioRef = useRef(false)
  const bufferedAudioGenerationRef = useRef(0)
  const bufferedAudioRef = useRef<BufferedAudioChunk[]>([])
  const bufferedAudioBytesRef = useRef(0)
  const bufferedAudioSecondsRef = useRef(0)
  const capturedChunkCountRef = useRef(0)
  const sessionIdRef = useRef('desktop')

  const cleanupCaptureResources = useCallback(() => {
    processorRef.current?.disconnect()
    sourceRef.current?.disconnect()
    processorRef.current = null
    sourceRef.current = null

    if (contextRef.current?.state !== 'closed') {
      void contextRef.current?.close()
    }
    contextRef.current = null

    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
  }, [])

  const resetBufferedAudio = useCallback(() => {
    bufferedAudioGenerationRef.current += 1
    bufferedAudioRef.current = []
    bufferedAudioBytesRef.current = 0
    bufferedAudioSecondsRef.current = 0
  }, [])

  const removeOldestBufferedAudioChunk = useCallback(() => {
    const chunk = bufferedAudioRef.current.shift()
    if (!chunk) {
      return
    }
    bufferedAudioBytesRef.current -= chunk.samples.byteLength
    bufferedAudioSecondsRef.current -= chunk.samples.length / chunk.sampleRate
  }, [])

  const appendBufferedAudioChunk = useCallback(
    (chunk: BufferedAudioChunk) => {
      bufferedAudioRef.current.push(chunk)
      bufferedAudioBytesRef.current += chunk.samples.byteLength
      bufferedAudioSecondsRef.current += chunk.samples.length / chunk.sampleRate

      // Why: worker/model startup can hang; keep only a bounded recent window
      // so renderer memory cannot grow forever while buffering is enabled.
      while (
        bufferedAudioRef.current.length > 0 &&
        (bufferedAudioBytesRef.current > MAX_BUFFERED_AUDIO_BYTES ||
          bufferedAudioSecondsRef.current > MAX_BUFFERED_AUDIO_SECONDS)
      ) {
        removeOldestBufferedAudioChunk()
      }
    },
    [removeOldestBufferedAudioChunk]
  )

  const start = useCallback(
    async (options: StartAudioCaptureOptions = {}) => {
      if (isCapturingRef.current) {
        return
      }
      const startRequest = startRequestRef.current + 1
      startRequestRef.current = startRequest
      cleanupCaptureResources()
      sessionIdRef.current = options.sessionId ?? 'desktop'
      bufferAudioRef.current = options.bufferAudio ?? false
      resetBufferedAudio()
      capturedChunkCountRef.current = 0

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      })
      if (startRequestRef.current !== startRequest) {
        stream.getTracks().forEach((track) => track.stop())
        return
      }
      streamRef.current = stream

      let context: AudioContext | null = null
      let source: MediaStreamAudioSourceNode | null = null
      let processor: ScriptProcessorNode | null = null
      try {
        // Why: requesting a specific sampleRate (e.g. 16kHz) in the AudioContext
        // can produce silence on macOS because the hardware mic runs at 44.1/48kHz.
        // Use the system default rate and let sherpa-onnx resample internally.
        context = new AudioContext()
        contextRef.current = context

        // Why: some Chromium builds suspend the AudioContext until a user gesture.
        // Resume it explicitly to ensure audio processing starts.
        if (context.state === 'suspended') {
          await context.resume()
        }
        if (startRequestRef.current !== startRequest || streamRef.current !== stream) {
          if (contextRef.current === context) {
            contextRef.current = null
          }
          if (context.state !== 'closed') {
            void context.close()
          }
          if (streamRef.current === stream) {
            streamRef.current = null
          }
          stream.getTracks().forEach((track) => track.stop())
          return
        }

        source = context.createMediaStreamSource(stream)

        // Why: ScriptProcessorNode is deprecated but AudioWorklet requires a
        // separate module file which complicates the Vite build pipeline. For
        // the initial implementation, ScriptProcessorNode is simpler and the
        // performance difference is negligible for speech capture.
        processor = context.createScriptProcessor(4096, 1, 1)

        const actualRate = context.sampleRate

        processor.onaudioprocess = (e: AudioProcessingEvent) => {
          if (
            !isCapturingRef.current ||
            startRequestRef.current !== startRequest ||
            processorRef.current !== processor
          ) {
            return
          }
          const samples = new Float32Array(e.inputBuffer.getChannelData(0))
          capturedChunkCountRef.current += 1
          if (bufferAudioRef.current) {
            appendBufferedAudioChunk({
              samples,
              sampleRate: actualRate,
              sessionId: sessionIdRef.current
            })
            return
          }
          void window.api.speech
            .feedAudio(samples, actualRate, sessionIdRef.current)
            .catch(() => undefined)
        }

        source.connect(processor)
        processor.connect(context.destination)

        processorRef.current = processor
        sourceRef.current = source
        isCapturingRef.current = true
      } catch (err) {
        processor?.disconnect()
        source?.disconnect()
        if (processorRef.current === processor) {
          processorRef.current = null
        }
        if (sourceRef.current === source) {
          sourceRef.current = null
        }
        if (contextRef.current === context) {
          contextRef.current = null
        }
        if (context && context.state !== 'closed') {
          void context.close()
        }
        stream.getTracks().forEach((track) => track.stop())
        if (streamRef.current === stream) {
          streamRef.current = null
        }
        if (startRequestRef.current === startRequest) {
          bufferAudioRef.current = false
          resetBufferedAudio()
        }
        if (startRequestRef.current !== startRequest) {
          return
        }
        throw err
      }
    },
    [appendBufferedAudioChunk, cleanupCaptureResources, resetBufferedAudio]
  )

  const flushBufferedAudio = useCallback(async () => {
    const flushGeneration = bufferedAudioGenerationRef.current
    try {
      // Why: keep buffering enabled while draining so live audio appends behind
      // startup audio instead of overtaking it through direct IPC sends.
      while (
        bufferedAudioGenerationRef.current === flushGeneration &&
        bufferedAudioRef.current.length > 0
      ) {
        const chunk = bufferedAudioRef.current[0]
        if (!chunk) {
          break
        }
        removeOldestBufferedAudioChunk()
        await window.api.speech.feedAudio(chunk.samples, chunk.sampleRate, chunk.sessionId)
      }
    } finally {
      if (bufferedAudioGenerationRef.current === flushGeneration) {
        bufferAudioRef.current = false
        resetBufferedAudio()
      }
    }
  }, [removeOldestBufferedAudioChunk, resetBufferedAudio])

  const discardBufferedAudio = useCallback(() => {
    bufferAudioRef.current = false
    resetBufferedAudio()
  }, [resetBufferedAudio])

  const getCapturedChunkCount = useCallback(() => capturedChunkCountRef.current, [])

  const stop = useCallback(
    (options: StopAudioCaptureOptions = {}) => {
      startRequestRef.current += 1
      isCapturingRef.current = false
      bufferAudioRef.current = false
      if (!options.preserveBufferedAudio) {
        resetBufferedAudio()
      }
      cleanupCaptureResources()
    },
    [cleanupCaptureResources, resetBufferedAudio]
  )

  return {
    start,
    stop,
    flushBufferedAudio,
    discardBufferedAudio,
    getCapturedChunkCount,
    isCapturingRef
  }
}
