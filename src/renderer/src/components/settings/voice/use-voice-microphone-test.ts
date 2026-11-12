import { useCallback, useEffect, useRef, useState } from 'react'
import { DICTATION_SAMPLE_RATE } from '../../../../../shared/rpc-contract/speech-params'
import {
  DEFAULT_DICTATION_METER,
  type DictationMeterState
} from '../../../../../shared/dictation-audio-meter'
import type { SpeechModelManifest, VoiceSettings } from '../../../../../shared/speech-types'
import { useAudioCapture } from '@/hooks/use-audio-capture'
import { installWindowVisibilityInterval } from '@/lib/window-activity/window-visibility-interval'
import { createNonSecureContextUuid } from '../../../../../shared/non-secure-context-uuid'
import { encodeMonoWav } from './voice-microphone-test-wav'

export const MICROPHONE_TEST_MAX_SECONDS = 10

export type VoiceMicrophoneTestPhase =
  | { kind: 'idle' }
  | { kind: 'starting' }
  | { kind: 'recording'; seconds: number }
  | { kind: 'playing'; seconds: number; total: number }
  | { kind: 'done'; total: number; heardSpeech: boolean }
  | { kind: 'failed'; error: unknown }

/** What the speech model made of the recording; absent when no model is ready. */
export type VoiceMicrophoneTestHeard =
  | { kind: 'listening' }
  | { kind: 'heard'; text: string }
  | { kind: 'failed' }

const CLOCK_MS = 250

async function transcribeRecording(modelId: string, samples: Float32Array): Promise<string> {
  const sessionId = `voice-microphone-test-${createNonSecureContextUuid()}`
  const finals: string[] = []
  let sessionError: string | null = null
  const unsubscribe = [
    window.api.speech.onFinalTranscript((event) => {
      if (event.sessionId === sessionId && event.text) {
        finals.push(event.text)
      }
    }),
    // A failed decode or cloud upload still lets the stop resolve; the error arrives as an event.
    window.api.speech.onError((event) => {
      if (event.sessionId === sessionId) {
        sessionError = event.error
      }
    })
  ]
  try {
    await window.api.speech.startDictation(modelId, undefined, sessionId)
    await window.api.speech.feedAudio(samples, DICTATION_SAMPLE_RATE, sessionId)
    // Finals and errors are sent before the stop resolves.
    await window.api.speech.stopDictation(sessionId)
  } catch (error) {
    await window.api.speech.cancelDictation(sessionId).catch(() => undefined)
    throw error
  } finally {
    unsubscribe.forEach((stop) => stop())
  }
  if (sessionError !== null) {
    throw new Error(sessionError)
  }
  return finals.join(' ').trim()
}

// Detach first: pause() queues a timeupdate that would flip the phase back to playing.
const silence = (audio: HTMLAudioElement): void => {
  audio.ontimeupdate = null
  audio.onended = null
  audio.pause()
}

/** Records up to ten seconds from the chosen microphone, plays it back, and asks the ready model what it heard. */
export function useVoiceMicrophoneTest(
  voiceSettings: VoiceSettings,
  readyModel: SpeechModelManifest | undefined
) {
  const [phase, setPhase] = useState<VoiceMicrophoneTestPhase>({ kind: 'idle' })
  const [heard, setHeard] = useState<VoiceMicrophoneTestHeard | null>(null)
  const [meter, setMeter] = useState<DictationMeterState>(DEFAULT_DICTATION_METER)
  const { start: startCapture, stop: stopCapture } = useAudioCapture(setMeter)
  const framesRef = useRef<Float32Array[]>([])
  const heardSpeechRef = useRef(false)
  // Ends the recording: the ten-second stop, and the clock that runs until then.
  const timerRef = useRef<(() => void) | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const runRef = useRef(0)

  const clearTimer = useCallback(() => {
    timerRef.current?.()
    timerRef.current = null
  }, [])

  const releaseAudio = useCallback(() => {
    const audio = audioRef.current
    audioRef.current = null
    if (audio) {
      silence(audio)
      URL.revokeObjectURL(audio.src)
    }
  }, [])

  useEffect(() => {
    if (meter.isSpeaking) {
      heardSpeechRef.current = true
    }
  }, [meter.isSpeaking])

  const play = useCallback(() => {
    const audio = audioRef.current
    if (!audio) {
      return
    }
    const total = audio.duration || 0
    audio.currentTime = 0
    audio.ontimeupdate = () => setPhase({ kind: 'playing', seconds: audio.currentTime, total })
    audio.onended = () => setPhase({ kind: 'done', total, heardSpeech: heardSpeechRef.current })
    setPhase({ kind: 'playing', seconds: 0, total })
    void audio.play().catch(() => audio.onended?.(new Event('ended')))
  }, [])

  const stopRecording = useCallback(() => {
    clearTimer()
    stopCapture()
    const frames = framesRef.current
    framesRef.current = []
    const length = frames.reduce((sum, frame) => sum + frame.length, 0)
    const samples = new Float32Array(length)
    let offset = 0
    for (const frame of frames) {
      samples.set(frame, offset)
      offset += frame.length
    }
    if (samples.length === 0) {
      setPhase({ kind: 'done', total: 0, heardSpeech: false })
      return
    }
    const audio = new Audio(URL.createObjectURL(encodeMonoWav(samples, DICTATION_SAMPLE_RATE)))
    audioRef.current = audio
    audio.onloadedmetadata = play
    audio.onerror = () => setPhase({ kind: 'done', total: 0, heardSpeech: heardSpeechRef.current })
    const run = runRef.current
    if (readyModel) {
      setHeard({ kind: 'listening' })
      void transcribeRecording(readyModel.id, samples).then(
        (text) => runRef.current === run && setHeard({ kind: 'heard', text }),
        () => runRef.current === run && setHeard({ kind: 'failed' })
      )
    }
  }, [clearTimer, play, readyModel, stopCapture])

  const start = useCallback(async () => {
    runRef.current += 1
    const run = runRef.current
    clearTimer()
    stopCapture()
    releaseAudio()
    setPhase({ kind: 'starting' })
    setHeard(null)
    framesRef.current = []
    heardSpeechRef.current = false
    try {
      // bufferAudio keeps the frames here: nothing reaches the speech host while recording.
      await startCapture({
        bufferAudio: true,
        microphoneDeviceId: voiceSettings.microphoneDeviceId,
        microphoneDeviceLabel: voiceSettings.microphoneDeviceLabel,
        onFrame: (samples) => framesRef.current.push(samples)
      })
    } catch (error) {
      if (runRef.current === run) {
        setPhase({ kind: 'failed', error })
      }
      return
    }
    // A newer Test, or leaving the page, took over while the microphone opened.
    if (runRef.current !== run) {
      return
    }
    const startedAt = performance.now()
    setPhase({ kind: 'recording', seconds: 0 })
    const stopClock = installWindowVisibilityInterval({
      run: () => setPhase({ kind: 'recording', seconds: (performance.now() - startedAt) / 1000 }),
      intervalMs: CLOCK_MS
    })
    const autoStop = setTimeout(stopRecording, MICROPHONE_TEST_MAX_SECONDS * 1000)
    timerRef.current = () => {
      stopClock()
      clearTimeout(autoStop)
    }
  }, [
    clearTimer,
    releaseAudio,
    startCapture,
    stopCapture,
    stopRecording,
    voiceSettings.microphoneDeviceId,
    voiceSettings.microphoneDeviceLabel
  ])

  const skipPlayback = useCallback(() => {
    const audio = audioRef.current
    if (audio) {
      silence(audio)
    }
    setPhase({ kind: 'done', total: audio?.duration || 0, heardSpeech: heardSpeechRef.current })
  }, [])

  useEffect(
    () => () => {
      runRef.current += 1
      clearTimer()
      stopCapture()
      releaseAudio()
    },
    [clearTimer, releaseAudio, stopCapture]
  )

  return { phase, heard, meter, start, stopRecording, play, skipPlayback }
}
