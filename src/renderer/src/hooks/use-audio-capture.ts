import { useRef, useCallback } from 'react'
import { useAppStore } from '@/store'
import {
  DICTATION_METER_PUBLISH_INTERVAL_MS,
  analyzeDictationAudioChunk,
  createDictationMeterAnalyzerState,
  toPublicDictationMeterState
} from '@/components/dictation/dictation-audio-meter'
import {
  getAudioCaptureConstraints,
  isMissingSelectedDeviceError
} from './audio-capture-constraints'
import { useAudioRecoveryBuffer } from './use-audio-recovery-buffer'
import { useAudioStartupBuffer } from './use-audio-startup-buffer'

type StartAudioCaptureOptions = {
  bufferAudio?: boolean
  sessionId?: string
}

type StopAudioCaptureOptions = {
  preserveBufferedAudio?: boolean
}

export function useAudioCapture() {
  const streamRef = useRef<MediaStream | null>(null)
  const contextRef = useRef<AudioContext | null>(null)
  const processorRef = useRef<ScriptProcessorNode | null>(null)
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null)
  const isCapturingRef = useRef(false)
  const startRequestRef = useRef(0)
  const capturedChunkCountRef = useRef(0)
  const sessionIdRef = useRef('desktop')
  const meterAnalyzerRef = useRef(createDictationMeterAnalyzerState())
  const lastMeterPublishAtRef = useRef(Number.NEGATIVE_INFINITY)
  const recoveryAudio = useAudioRecoveryBuffer()
  const startupAudio = useAudioStartupBuffer()

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

  const resetMeter = useCallback(() => {
    meterAnalyzerRef.current = createDictationMeterAnalyzerState()
    lastMeterPublishAtRef.current = Number.NEGATIVE_INFINITY
    useAppStore.getState().resetDictationMeter()
  }, [])

  const start = useCallback(
    async (options: StartAudioCaptureOptions = {}) => {
      if (isCapturingRef.current) {
        return
      }
      const startRequest = startRequestRef.current + 1
      startRequestRef.current = startRequest
      cleanupCaptureResources()
      sessionIdRef.current = options.sessionId ?? 'desktop'
      startupAudio.setEnabled(options.bufferAudio ?? false)
      startupAudio.reset()
      capturedChunkCountRef.current = 0
      resetMeter()
      recoveryAudio.clear()
      const selectedInputDeviceId = useAppStore.getState().settings?.voice?.inputDeviceId?.trim()

      let stream: MediaStream
      try {
        stream = await navigator.mediaDevices.getUserMedia(
          getAudioCaptureConstraints(selectedInputDeviceId)
        )
      } catch (err) {
        if (!selectedInputDeviceId || !isMissingSelectedDeviceError(err)) {
          throw err
        }
        stream = await navigator.mediaDevices.getUserMedia(getAudioCaptureConstraints(undefined))
      }
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
          const now = performance.now()
          meterAnalyzerRef.current = analyzeDictationAudioChunk(
            samples,
            now,
            meterAnalyzerRef.current
          )
          if (now - lastMeterPublishAtRef.current >= DICTATION_METER_PUBLISH_INTERVAL_MS) {
            lastMeterPublishAtRef.current = now
            useAppStore
              .getState()
              .setDictationMeter(toPublicDictationMeterState(meterAnalyzerRef.current))
          }
          capturedChunkCountRef.current += 1
          const recoveryChunk = {
            samples,
            sampleRate: actualRate,
            sessionId: sessionIdRef.current
          }
          recoveryAudio.append(recoveryChunk)
          if (startupAudio.isEnabled()) {
            startupAudio.append(recoveryChunk)
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
          startupAudio.setEnabled(false)
          startupAudio.reset()
          resetMeter()
        }
        if (startRequestRef.current !== startRequest) {
          return
        }
        throw err
      }
    },
    [cleanupCaptureResources, recoveryAudio, resetMeter, startupAudio]
  )

  const flushBufferedAudio = startupAudio.flush

  const discardBufferedAudio = useCallback(() => {
    startupAudio.setEnabled(false)
    startupAudio.reset()
    resetMeter()
  }, [resetMeter, startupAudio])

  const getCapturedChunkCount = useCallback(() => capturedChunkCountRef.current, [])

  const stop = useCallback(
    (options: StopAudioCaptureOptions = {}) => {
      startRequestRef.current += 1
      isCapturingRef.current = false
      startupAudio.setEnabled(false)
      if (!options.preserveBufferedAudio) {
        startupAudio.reset()
        resetMeter()
      }
      cleanupCaptureResources()
      if (options.preserveBufferedAudio) {
        resetMeter()
      }
    },
    [cleanupCaptureResources, resetMeter, startupAudio]
  )

  return {
    start,
    stop,
    flushBufferedAudio,
    discardBufferedAudio,
    getCapturedChunkCount,
    getRecoveryAudioChunks: recoveryAudio.getChunks,
    clearRecoveryAudio: recoveryAudio.clear,
    isCapturingRef
  }
}
