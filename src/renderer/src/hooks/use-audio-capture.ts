import { useRef, useCallback } from 'react'

export function useAudioCapture() {
  const streamRef = useRef<MediaStream | null>(null)
  const contextRef = useRef<AudioContext | null>(null)
  const processorRef = useRef<ScriptProcessorNode | null>(null)
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null)
  const isCapturingRef = useRef(false)

  const start = useCallback(async () => {
    if (isCapturingRef.current) {
      return
    }

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    })
    streamRef.current = stream

    try {
      // Why: requesting a specific sampleRate (e.g. 16kHz) in the AudioContext
      // can produce silence on macOS because the hardware mic runs at 44.1/48kHz.
      // Use the system default rate and let sherpa-onnx resample internally.
      const context = new AudioContext()
      contextRef.current = context

      // Why: some Chromium builds suspend the AudioContext until a user gesture.
      // Resume it explicitly to ensure audio processing starts.
      if (context.state === 'suspended') {
        await context.resume()
      }

      const source = context.createMediaStreamSource(stream)

      // Why: ScriptProcessorNode is deprecated but AudioWorklet requires a
      // separate module file which complicates the Vite build pipeline. For
      // the initial implementation, ScriptProcessorNode is simpler and the
      // performance difference is negligible for speech capture.
      const processor = context.createScriptProcessor(4096, 1, 1)

      const actualRate = context.sampleRate

      processor.onaudioprocess = (e: AudioProcessingEvent) => {
        if (!isCapturingRef.current) {
          return
        }
        const samples = new Float32Array(e.inputBuffer.getChannelData(0))
        window.api.speech.feedAudio(samples, actualRate)
      }

      source.connect(processor)
      processor.connect(context.destination)

      processorRef.current = processor
      sourceRef.current = source
      isCapturingRef.current = true
    } catch (err) {
      processorRef.current?.disconnect()
      sourceRef.current?.disconnect()
      processorRef.current = null
      sourceRef.current = null
      if (contextRef.current?.state !== 'closed') {
        void contextRef.current?.close()
      }
      contextRef.current = null
      stream.getTracks().forEach((track) => track.stop())
      streamRef.current = null
      throw err
    }
  }, [])

  const stop = useCallback(() => {
    isCapturingRef.current = false

    processorRef.current?.disconnect()
    sourceRef.current?.disconnect()
    processorRef.current = null
    sourceRef.current = null

    if (contextRef.current?.state !== 'closed') {
      void contextRef.current?.close()
    }
    contextRef.current = null

    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
  }, [])

  return { start, stop, isCapturingRef }
}
