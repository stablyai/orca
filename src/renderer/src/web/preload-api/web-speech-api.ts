import type { SpeechApi } from '../../../../preload/api/speech-api'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { getDefaultVoiceSettings } from '../../../../shared/constants'
import type {
  SpeechErrorEvent,
  SpeechLifecycleEvent,
  SpeechTranscriptEvent
} from '../../../../shared/speech-types'
import { hostDictationErrorMessage } from '../../../../shared/host-dictation-error-messages'
import {
  MAX_DICTATION_AUDIO_CHUNK_BYTES,
  PCM_BYTES_PER_SAMPLE
} from '../../../../shared/rpc-contract/speech-params'
import { encodeBase64Bytes } from '@/lib/base64-bytes'
import { callRuntimeResult } from './web-runtime-calls'

const MAX_CHUNK_SAMPLES = MAX_DICTATION_AUDIO_CHUNK_BYTES / PCM_BYTES_PER_SAMPLE
// Matches the phone: a long recording can take a while to transcribe on the host.
const FINISH_TIMEOUT_MS = 75_000

type HostDictation = {
  sessionId: string
  dictationId: string
  seq: number
  sampleRate: number
  pending: Float32Array[]
  sending: Promise<void> | null
  failed: boolean
}

type Listeners<T> = Set<(data: T) => void>

function subscribe<T>(listeners: Listeners<T>, callback: (data: T) => void): () => void {
  listeners.add(callback)
  return () => listeners.delete(callback)
}

function emit<T>(listeners: Listeners<T>, data: T): void {
  for (const listener of listeners) {
    listener(data)
  }
}

function hostErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return hostDictationErrorMessage(message) ?? message
}

function takePendingAudio(dictation: HostDictation): Float32Array {
  const total = dictation.pending.reduce((sum, chunk) => sum + chunk.length, 0)
  const audio = new Float32Array(total)
  let offset = 0
  for (const chunk of dictation.pending) {
    audio.set(chunk, offset)
    offset += chunk.length
  }
  dictation.pending = audio.length > MAX_CHUNK_SAMPLES ? [audio.subarray(MAX_CHUNK_SAMPLES)] : []
  return audio.subarray(0, MAX_CHUNK_SAMPLES)
}

function encodePcm16Base64(samples: Float32Array): string {
  const pcm = new DataView(new ArrayBuffer(samples.length * PCM_BYTES_PER_SAMPLE))
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index] ?? 0))
    pcm.setInt16(index * PCM_BYTES_PER_SAMPLE, Math.round(sample * 0x7fff), true)
  }
  return encodeBase64Bytes(new Uint8Array(pcm.buffer))
}

/** Dictation for the paired web client: the host transcribes over the same RPCs the phone uses. */
export function createWebSpeechApi(): Pick<
  SpeechApi,
  | 'startDictation'
  | 'feedAudio'
  | 'stopDictation'
  | 'onPartialTranscript'
  | 'onFinalTranscript'
  | 'onStopped'
  | 'onError'
> {
  const partialListeners: Listeners<SpeechTranscriptEvent> = new Set()
  const finalListeners: Listeners<SpeechTranscriptEvent> = new Set()
  const stoppedListeners: Listeners<SpeechLifecycleEvent> = new Set()
  const errorListeners: Listeners<SpeechErrorEvent> = new Set()
  let active: HostDictation | null = null

  // One chunk in flight at a time; audio captured meanwhile rides in the next one, so slow links batch instead of queueing.
  const sendPendingAudio = async (dictation: HostDictation): Promise<void> => {
    while (dictation.pending.length > 0 && !dictation.failed) {
      try {
        const reply = await callRuntimeResult<{ text?: string }>('speech.dictation.chunk', {
          dictationId: dictation.dictationId,
          audioBase64: encodePcm16Base64(takePendingAudio(dictation)),
          sampleRate: dictation.sampleRate,
          seq: dictation.seq++
        })
        if (reply?.text) {
          emit(partialListeners, { sessionId: dictation.sessionId, text: reply.text })
        }
      } catch (error) {
        dictation.failed = true
        dictation.pending = []
        emit(errorListeners, { sessionId: dictation.sessionId, error: hostErrorMessage(error) })
      }
    }
    dictation.sending = null
  }

  return {
    startDictation: async (modelId, _hotwords, sessionId) => {
      const dictation: HostDictation = {
        sessionId,
        dictationId: `web-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
        seq: 0,
        sampleRate: 0,
        pending: [],
        sending: null,
        failed: false
      }
      active = dictation
      try {
        await callRuntimeResult('speech.dictation.start', {
          dictationId: dictation.dictationId,
          modelId
        })
      } catch (error) {
        if (active === dictation) {
          active = null
        }
        throw error
      }
    },
    feedAudio: async (samples, sampleRate, sessionId) => {
      const dictation = active
      if (!dictation || dictation.sessionId !== sessionId || dictation.failed) {
        return
      }
      dictation.pending.push(samples)
      dictation.sampleRate = sampleRate
      dictation.sending ??= sendPendingAudio(dictation)
    },
    stopDictation: async (sessionId = '') => {
      const dictation = active?.sessionId === sessionId ? active : null
      try {
        if (!dictation) {
          return
        }
        active = null
        while (dictation.sending) {
          await dictation.sending
        }
        if (dictation.failed) {
          await callRuntimeResult('speech.dictation.cancel', {
            dictationId: dictation.dictationId
          }).catch(() => undefined)
          return
        }
        const { text } = await callRuntimeResult<{ text: string }>(
          'speech.dictation.finish',
          { dictationId: dictation.dictationId },
          FINISH_TIMEOUT_MS
        )
        if (text) {
          emit(finalListeners, { sessionId, text })
        }
      } catch (error) {
        emit(errorListeners, { sessionId, error: hostErrorMessage(error) })
      } finally {
        emit(stoppedListeners, { sessionId })
      }
    },
    onPartialTranscript: (callback) => subscribe(partialListeners, callback),
    onFinalTranscript: (callback) => subscribe(finalListeners, callback),
    onStopped: (callback) => subscribe(stoppedListeners, callback),
    onError: (callback) => subscribe(errorListeners, callback)
  }
}

/** The host refuses dictation unless its own voice settings allow it, so a paired browser follows them. */
export function followHostVoiceSettings(
  local: GlobalSettings,
  host: Partial<GlobalSettings>
): Partial<GlobalSettings> {
  if (!host.voice) {
    return {}
  }
  const voice = local.voice ?? getDefaultVoiceSettings()
  return {
    voice: { ...voice, enabled: host.voice.enabled === true, sttModel: host.voice.sttModel ?? '' }
  }
}
