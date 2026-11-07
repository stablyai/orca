import { useRef, useCallback } from 'react'
import { openMicrophoneCaptureStream } from '@/components/dictation/microphone-devices'
import captureWorkletUrl from '@/components/dictation/dictation-capture-worklet?worker&url'
import {
  DICTATION_CAPTURE_WORKLET_NAME,
  type DictationCaptureWorkletMessage,
  type DictationCaptureWorkletOptions
} from '@/components/dictation/dictation-capture-worklet-protocol'
import { DICTATION_SAMPLE_RATE } from '../../../shared/rpc-contract/speech-params'
import { DICTATION_METER_WINDOW_MS } from '../../../shared/dictation-audio-meter'
import { useAudioCaptureMeter, type DictationMeterPublisher } from './use-audio-capture-meter'
import { useAudioCaptureStopTail, type StopCaptureOptions } from './use-audio-capture-stop-tail'

type BufferedAudioChunk = {
  samples: Float32Array
  sessionId: string
}

type StartAudioCaptureOptions = {
  bufferAudio?: boolean
  sessionId?: string
  /** null/undefined = system default input device */
  microphoneDeviceId?: string | null
  /** Cached label, used to re-resolve a device whose id was re-salted */
  microphoneDeviceLabel?: string | null
  /** Fires when the live input device disappears mid-capture */
  onCaptureLost?: () => void
  /** Fires when the host's session accepts no more audio (cloud upload cap) */
  onAudioLimitReached?: () => void
}

export type StartAudioCaptureResult = {
  fellBackToDefaultMicrophone: boolean
}

const MAX_BUFFERED_AUDIO_SECONDS = 30
const MAX_BUFFERED_AUDIO_BYTES = 8 * 1024 * 1024
const CAPTURE_WORKLET_OPTIONS: DictationCaptureWorkletOptions = {
  outputSampleRate: DICTATION_SAMPLE_RATE,
  frameSamples: DICTATION_SAMPLE_RATE / 10,
  levelWindowMs: DICTATION_METER_WINDOW_MS
}

export function useAudioCapture(publishMeter?: DictationMeterPublisher) {
  const streamRef = useRef<MediaStream | null>(null)
  const contextRef = useRef<AudioContext | null>(null)
  const processorRef = useRef<AudioWorkletNode | null>(null)
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
  const trackLostCleanupRef = useRef<(() => void) | null>(null)
  const { resetMeter, measureLevel, getLastSpeechAt } = useAudioCaptureMeter(publishMeter)

  const cleanupCaptureResources = useCallback(() => {
    trackLostCleanupRef.current?.()
    trackLostCleanupRef.current = null

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
    bufferedAudioSecondsRef.current -= chunk.samples.length / DICTATION_SAMPLE_RATE
  }, [])

  const appendBufferedAudioChunk = useCallback(
    (chunk: BufferedAudioChunk) => {
      bufferedAudioRef.current.push(chunk)
      bufferedAudioBytesRef.current += chunk.samples.byteLength
      bufferedAudioSecondsRef.current += chunk.samples.length / DICTATION_SAMPLE_RATE

      // Bound recent buffering while worker/model startup hangs to prevent unlimited renderer memory growth.
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

  // The one place a 16 kHz frame leaves capture: the startup buffer or the speech host.
  const deliverFrame = useCallback(
    (samples: Float32Array, onAudioLimitReached?: () => void) => {
      if (bufferAudioRef.current) {
        appendBufferedAudioChunk({ samples, sessionId: sessionIdRef.current })
        return
      }
      void window.api.speech
        .feedAudio(samples, DICTATION_SAMPLE_RATE, sessionIdRef.current)
        .then((limitReached) => limitReached && onAudioLimitReached?.())
        .catch(() => undefined)
    },
    [appendBufferedAudioChunk]
  )

  const start = useCallback(
    async (
      options: StartAudioCaptureOptions = {}
    ): Promise<StartAudioCaptureResult | undefined> => {
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
      resetMeter()

      const { stream, fellBackToDefaultMicrophone } = await openMicrophoneCaptureStream({
        preferredDeviceId: options.microphoneDeviceId,
        preferredDeviceLabel: options.microphoneDeviceLabel,
        getUserMedia: (constraints) => navigator.mediaDevices.getUserMedia(constraints),
        enumerateDevices: navigator.mediaDevices?.enumerateDevices
          ? () => navigator.mediaDevices.enumerateDevices()
          : undefined
      })
      if (startRequestRef.current !== startRequest) {
        stream.getTracks().forEach((track) => track.stop())
        return
      }
      streamRef.current = stream

      let context: AudioContext | null = null
      let source: MediaStreamAudioSourceNode | null = null
      let processor: AudioWorkletNode | null = null
      try {
        // Run at the hardware rate and resample in the worklet; forcing 16kHz can produce macOS microphone silence.
        context = new AudioContext()
        contextRef.current = context

        // Explicitly resume AudioContext because Chromium may suspend it pending a user gesture.
        await Promise.all([
          context.state === 'suspended' ? context.resume() : undefined,
          context.audioWorklet.addModule(captureWorkletUrl)
        ])
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
        // Mono downmix as before; the worklet sends 16 kHz frames and a level per meter window.
        processor = new AudioWorkletNode(context, DICTATION_CAPTURE_WORKLET_NAME, {
          channelCount: 1,
          channelCountMode: 'explicit',
          processorOptions: CAPTURE_WORKLET_OPTIONS
        })
        processor.port.onmessage = ({ data }: MessageEvent<DictationCaptureWorkletMessage>) => {
          if (
            !isCapturingRef.current ||
            startRequestRef.current !== startRequest ||
            processorRef.current !== processor
          ) {
            return
          }
          if (data.type === 'level') {
            measureLevel(data)
            return
          }
          capturedChunkCountRef.current += 1
          deliverFrame(data.samples, options.onAudioLimitReached)
        }

        source.connect(processor)
        processor.connect(context.destination)

        processorRef.current = processor
        sourceRef.current = source
        isCapturingRef.current = true

        // Device loss ends the track but leaves zero-filled processing alive; stop capture so dictation cannot appear healthy.
        const onCaptureLost = options.onCaptureLost
        const audioTrack = stream.getAudioTracks()[0]
        if (onCaptureLost && audioTrack) {
          const handleTrackEnded = (): void => {
            if (startRequestRef.current !== startRequest || !isCapturingRef.current) {
              return
            }
            onCaptureLost()
          }
          audioTrack.addEventListener('ended', handleTrackEnded)
          trackLostCleanupRef.current = () => {
            audioTrack.removeEventListener('ended', handleTrackEnded)
          }
        }
        return { fellBackToDefaultMicrophone }
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
    [cleanupCaptureResources, deliverFrame, measureLevel, resetBufferedAudio, resetMeter]
  )

  const flushBufferedAudio = useCallback(async () => {
    const flushGeneration = bufferedAudioGenerationRef.current
    try {
      // Keep buffering through drain so live samples queue behind startup audio instead of overtaking it.
      while (
        bufferedAudioGenerationRef.current === flushGeneration &&
        bufferedAudioRef.current.length > 0
      ) {
        const chunk = bufferedAudioRef.current[0]
        if (!chunk) {
          break
        }
        removeOldestBufferedAudioChunk()
        await window.api.speech.feedAudio(chunk.samples, DICTATION_SAMPLE_RATE, chunk.sessionId)
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
    (options: StopCaptureOptions = {}) => {
      startRequestRef.current += 1
      isCapturingRef.current = false
      bufferAudioRef.current = false
      if (!options.preserveBufferedAudio) {
        resetBufferedAudio()
      }
      cleanupCaptureResources()
      resetMeter()
    },
    [cleanupCaptureResources, resetBufferedAudio, resetMeter]
  )

  const finish = useAudioCaptureStopTail(isCapturingRef, startRequestRef, stop)

  return {
    start,
    stop,
    finish,
    flushBufferedAudio,
    discardBufferedAudio,
    getCapturedChunkCount,
    getLastSpeechAt,
    isCapturingRef
  }
}
