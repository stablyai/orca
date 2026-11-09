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
import { createNonSecureContextUuid } from '../../../../shared/non-secure-context-uuid'
import { errorMessage } from '../../../../shared/error-message'
import { callRuntimeResult } from './web-runtime-calls'
import { withTimeout } from '../../../../shared/promise-timeout-fallback'
import { pairedDictationFinishTimeoutMs } from '../../../../shared/dictation-finish-deadlines'

const MAX_CHUNK_SAMPLES = MAX_DICTATION_AUDIO_CHUNK_BYTES / PCM_BYTES_PER_SAMPLE
// A slow link can leave a backlog of chunks behind Stop; past this, keep the text so far instead.
const STOP_DRAIN_TIMEOUT_MS = 10_000

type HostDictation = {
  sessionId: string
  dictationId: string
  seq: number
  sampleRate: number
  sentAudioSeconds: number
  pending: Float32Array[]
  sending: Promise<void> | null
  failed: boolean
  textSoFar: string
  // The host's cloud upload filled up; reported to capture once so it stops like the desktop does.
  audioLimit: 'not-reached' | 'reached' | 'reported'
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
  const message = errorMessage(error)
  return hostDictationErrorMessage(message) ?? message
}

function takePendingAudio(dictation: HostDictation): Float32Array {
  const [first] = dictation.pending
  if (dictation.pending.length === 1 && first && first.length <= MAX_CHUNK_SAMPLES) {
    dictation.pending = []
    return first
  }
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
  // Int16Array is little-endian on every platform Orca runs on, as the host's readInt16LE expects.
  const pcm = new Int16Array(samples.length)
  for (let index = 0; index < samples.length; index += 1) {
    pcm[index] = Math.round(Math.max(-1, Math.min(1, samples[index] ?? 0)) * 0x7fff)
  }
  return encodeBase64Bytes(new Uint8Array(pcm.buffer))
}

/** Dictation for the paired web client: the host transcribes over the same RPCs the phone uses. */
export function createWebSpeechApi(): Pick<
  SpeechApi,
  | 'startDictation'
  | 'feedAudio'
  | 'stopDictation'
  | 'cancelDictation'
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

  const cancelOnHost = (dictation: HostDictation): Promise<unknown> =>
    callRuntimeResult('speech.dictation.cancel', { dictationId: dictation.dictationId }).catch(
      () => undefined
    )

  // Keep what the host already heard; this session can't be finished any more.
  const fail = (dictation: HostDictation, error: unknown): void => {
    const { sessionId, textSoFar } = dictation
    if (textSoFar) {
      emit(finalListeners, { sessionId, text: textSoFar })
    }
    emit(errorListeners, { sessionId, error: hostErrorMessage(error) })
  }

  // One chunk in flight at a time; audio captured meanwhile rides in the next one, so slow links batch instead of queueing.
  const sendPendingAudio = async (dictation: HostDictation): Promise<void> => {
    while (dictation.pending.length > 0 && !dictation.failed) {
      try {
        const audio = takePendingAudio(dictation)
        dictation.sentAudioSeconds += audio.length / dictation.sampleRate
        const reply = await callRuntimeResult<{
          text?: string
          audioLimitReached?: boolean
        }>('speech.dictation.chunk', {
          dictationId: dictation.dictationId,
          audioBase64: encodePcm16Base64(audio),
          sampleRate: dictation.sampleRate,
          seq: dictation.seq++
        })
        if (reply?.audioLimitReached && dictation.audioLimit === 'not-reached') {
          dictation.audioLimit = 'reached'
        }
        // The host repeats unchanged text about once a second in case a reply was lost.
        if (reply?.text && reply.text !== dictation.textSoFar) {
          dictation.textSoFar = reply.text
          emit(partialListeners, { sessionId: dictation.sessionId, text: reply.text })
        }
      } catch (error) {
        // A stop that gave up on the backlog has already reported this session.
        if (!dictation.failed) {
          dictation.failed = true
          dictation.pending = []
          fail(dictation, error)
        }
      }
    }
    dictation.sending = null
  }

  return {
    // No model id, like the phone: the host dictates with the model it has selected now.
    startDictation: async (_modelId, _hotwords, sessionId) => {
      const dictation: HostDictation = {
        sessionId,
        dictationId: `web-${createNonSecureContextUuid()}`,
        seq: 0,
        sampleRate: 0,
        sentAudioSeconds: 0,
        pending: [],
        sending: null,
        failed: false,
        textSoFar: '',
        audioLimit: 'not-reached'
      }
      active = dictation
      try {
        await callRuntimeResult('speech.dictation.start', { dictationId: dictation.dictationId })
        // A cancel that landed while the host was starting couldn't reach this dictation yet.
        if (active !== dictation) {
          void cancelOnHost(dictation)
        }
      } catch (error) {
        if (active === dictation) {
          active = null
        }
        // A start that timed out may still finish on the host and hold one of its dictation slots.
        void cancelOnHost(dictation)
        throw error
      }
    },
    // A chunk reply reports the cap after its audio was sent, so a later feed passes it on.
    feedAudio: async (samples, sampleRate, sessionId) => {
      const dictation = active
      if (!dictation || dictation.sessionId !== sessionId || dictation.failed) {
        return false
      }
      dictation.pending.push(samples)
      dictation.sampleRate = sampleRate
      dictation.sending ??= sendPendingAudio(dictation)
      if (dictation.audioLimit !== 'reached') {
        return false
      }
      dictation.audioLimit = 'reported'
      return true
    },
    stopDictation: async (sessionId = '') => {
      const dictation = active?.sessionId === sessionId ? active : null
      try {
        if (!dictation) {
          return
        }
        active = null
        const drained = dictation.sending
          ? await withTimeout(
              dictation.sending.then(() => true),
              STOP_DRAIN_TIMEOUT_MS,
              false
            )
          : true
        if (!drained) {
          dictation.failed = true
          dictation.pending = []
          throw new Error('dictation_stream_closing')
        }
        if (dictation.failed) {
          await cancelOnHost(dictation)
          return
        }
        const { text } = await callRuntimeResult<{ text: string }>(
          'speech.dictation.finish',
          { dictationId: dictation.dictationId },
          pairedDictationFinishTimeoutMs(dictation.sentAudioSeconds)
        )
        if (text) {
          emit(finalListeners, { sessionId, text })
        }
      } catch (error) {
        if (dictation) {
          // A finish that timed out here may still hold one of the host's dictation slots.
          void cancelOnHost(dictation)
          fail(dictation, error)
        }
      } finally {
        emit(stoppedListeners, { sessionId })
      }
    },
    cancelDictation: async (sessionId) => {
      const dictation = active?.sessionId === sessionId ? active : null
      if (!dictation) {
        return
      }
      active = null
      dictation.failed = true
      dictation.pending = []
      await cancelOnHost(dictation)
      emit(stoppedListeners, { sessionId })
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
  // Browsers expose no microphone on plain-http pages, so the mic stays off there.
  const canCapture = Boolean(globalThis.navigator?.mediaDevices?.getUserMedia)
  return {
    voice: {
      ...voice,
      enabled: host.voice.enabled === true && canCapture,
      sttModel: host.voice.sttModel ?? ''
    }
  }
}
