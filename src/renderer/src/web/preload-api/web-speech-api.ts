import { z } from 'zod'
import type { PreloadApi } from '../../../../preload/api-types'
import type { SecretAtRestProtection } from '../../../../shared/secure-storage/secret-at-rest-protection'
import type {
  SpeechErrorEvent,
  SpeechLifecycleEvent,
  SpeechModelManifest,
  SpeechModelState,
  SpeechTranscriptEvent
} from '../../../../shared/speech/speech-types'
import { subscribeRuntimeEnvironment } from '../../runtime/rpc/environment-revisions/runtime-environment-pairing-refresh'
import { callRuntimeResult } from '../runtime/client/web-runtime-calls'

const SpeechEvent = z.union([
  z.object({ type: z.enum(['ready', 'stopped']), sessionId: z.string() }),
  z.object({ type: z.enum(['partial', 'final']), sessionId: z.string(), text: z.string() }),
  z.object({ type: z.literal('error'), sessionId: z.string(), error: z.string() }),
  z.object({ type: z.literal('downloadProgress'), modelId: z.string(), progress: z.number() }),
  z.object({ type: z.literal('end') }),
  z.object({ type: z.literal('ready'), subscriptionId: z.string() })
])

type ListenerMap = {
  partial: Set<(event: SpeechTranscriptEvent) => void>
  final: Set<(event: SpeechTranscriptEvent) => void>
  ready: Set<(event: SpeechLifecycleEvent) => void>
  stopped: Set<(event: SpeechLifecycleEvent) => void>
  error: Set<(event: SpeechErrorEvent) => void>
  downloadProgress: Set<(event: { modelId: string; progress: number }) => void>
}

function encodeFloatAudio(samples: Float32Array): string {
  const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength)
  let binary = ''
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
  }
  return btoa(binary)
}

export function createWebSpeechApi(): NonNullable<Partial<PreloadApi>['speech']> {
  const listeners: ListenerMap = {
    partial: new Set(),
    final: new Set(),
    ready: new Set(),
    stopped: new Set(),
    error: new Set(),
    downloadProgress: new Set()
  }
  let subscription: { unsubscribe: () => void } | null = null
  let starting = false

  const dispatch = (event: z.infer<typeof SpeechEvent>): void => {
    if (event.type === 'end') {
      subscription = null
      if (listeners.partial.size > 0) {
        void ensureSubscription()
      }
      return
    }
    if (event.type === 'ready' && 'subscriptionId' in event) {
      return
    }
    if (event.type === 'partial' || event.type === 'final') {
      for (const listener of listeners[event.type]) {
        listener({ text: event.text, sessionId: event.sessionId })
      }
    } else if (event.type === 'ready' || event.type === 'stopped') {
      for (const listener of listeners[event.type]) {
        listener({ sessionId: event.sessionId })
      }
    } else if (event.type === 'error') {
      for (const listener of listeners.error) {
        listener({ error: event.error, sessionId: event.sessionId })
      }
    } else if (event.type === 'downloadProgress') {
      for (const listener of listeners.downloadProgress) {
        listener({ modelId: event.modelId, progress: event.progress })
      }
    }
  }

  async function ensureSubscription(): Promise<void> {
    if (subscription || starting || Object.values(listeners).every((set) => set.size === 0)) {
      return
    }
    starting = true
    try {
      subscription = await subscribeRuntimeEnvironment(
        {
          selector: 'active',
          method: 'speech.desktop.events',
          params: null,
          timeoutMs: 15_000
        },
        {
          onResponse: (response) => {
            if (response.ok) {
              const event = SpeechEvent.safeParse(response.result)
              if (event.success) {
                dispatch(event.data)
              }
            }
          },
          onError: (error) => {
            for (const listener of listeners.error) {
              listener({ error: String(error), sessionId: 'desktop' })
            }
          },
          onClose: () => {
            subscription = null
            void ensureSubscription()
          }
        }
      )
    } catch (error) {
      for (const listener of listeners.error) {
        listener({ error: String(error), sessionId: 'desktop' })
      }
    } finally {
      starting = false
    }
  }

  function on<T>(target: Set<(event: T) => void>, listener: (event: T) => void): () => void {
    target.add(listener)
    void ensureSubscription()
    return () => target.delete(listener)
  }

  return {
    getCatalog: () => callRuntimeResult<SpeechModelManifest[]>('speech.desktop.getCatalog'),
    getModelStates: () => callRuntimeResult<SpeechModelState[]>('speech.desktop.getModelStates'),
    getOpenAiApiKeyStatus: () =>
      callRuntimeResult<{
        configured: boolean
        protection: SecretAtRestProtection | null
      }>('speech.desktop.getOpenAiApiKeyStatus'),
    saveOpenAiApiKey: (apiKey) =>
      callRuntimeResult<{ configured: boolean }>('speech.desktop.saveOpenAiApiKey', { apiKey }),
    clearOpenAiApiKey: () =>
      callRuntimeResult<{ configured: boolean }>('speech.desktop.clearOpenAiApiKey'),
    getOpenAiCompatibleProvider: () => Promise.reject(new Error('unsupported')),
    saveOpenAiCompatibleProvider: () => Promise.reject(new Error('unsupported')),
    clearOpenAiCompatibleProvider: () => Promise.reject(new Error('unsupported')),
    cancelDictation: () => Promise.reject(new Error('unsupported')),
    onSpeechPending: () => () => {},
    downloadModel: (modelId) => callRuntimeResult('speech.desktop.downloadModel', { modelId }),
    cancelDownload: (modelId) => callRuntimeResult('speech.desktop.cancelDownload', { modelId }),
    deleteModel: (modelId) => callRuntimeResult('speech.desktop.deleteModel', { modelId }),
    startDictation: (modelId, hotwords, sessionId) =>
      callRuntimeResult('speech.desktop.startDictation', { modelId, hotwords, sessionId }),
    feedAudio: (samples, sampleRate, sessionId = 'desktop') =>
      callRuntimeResult('speech.desktop.feedAudio', {
        audioBase64: encodeFloatAudio(samples),
        sampleRate,
        sessionId
      }),
    stopDictation: (sessionId = 'desktop') =>
      callRuntimeResult('speech.desktop.stopDictation', { sessionId }),
    onPartialTranscript: (listener) => on(listeners.partial, listener),
    onFinalTranscript: (listener) => on(listeners.final, listener),
    onDownloadProgress: (listener) => on(listeners.downloadProgress, listener),
    onReady: (listener) => on(listeners.ready, listener),
    onStopped: (listener) => on(listeners.stopped, listener),
    onError: (listener) => on(listeners.error, listener)
  }
}
