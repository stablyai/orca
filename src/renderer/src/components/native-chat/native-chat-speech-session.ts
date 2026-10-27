import {
  chunkNativeChatSpeech,
  nativeChatTextForSpeech,
  segmentNativeChatSpeech,
  type ResolvedNativeChatSpeech
} from '../../../../shared/native-chat-speech'
import { withoutNativeChatVisualDirectiveLines } from '../../../../shared/native-chat-visual-directive'

type SpeechListener = () => void

export type WebSpeechVoice = { lang: string; localService?: boolean }

export type WebSpeechUtterance = {
  text: string
  lang: string
  rate: number
  voice: WebSpeechVoice | null
  onend: (() => void) | null
  onerror: (() => void) | null
}

export type WebSpeechSynth = {
  cancel: () => void
  speak: (utterance: WebSpeechUtterance) => void
  getVoices: () => WebSpeechVoice[]
}

let speakingMessageId: string | null = null
let speechGeneration = 0
let currentAudio: HTMLAudioElement | null = null
const listeners = new Set<SpeechListener>()

function emitSpeechChange(): void {
  for (const listener of listeners) {
    listener()
  }
}

export function subscribeNativeChatSpeech(listener: SpeechListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function getNativeChatSpeakingMessageId(): string | null {
  return speakingMessageId
}

function setSpeaking(messageId: string | null): void {
  if (speakingMessageId === messageId) {
    return
  }
  speakingMessageId = messageId
  emitSpeechChange()
}

export function stopNativeChatSpeech(): void {
  speechGeneration += 1
  if (typeof window !== 'undefined') {
    window.speechSynthesis?.cancel()
    void window.api?.speech.cancelSynthesis?.()
  }
  if (currentAudio) {
    currentAudio.pause()
    currentAudio.src = ''
    currentAudio = null
  }
  setSpeaking(null)
}

function voiceFor(synth: WebSpeechSynth, lang: 'ru-RU' | 'en-US'): WebSpeechVoice | null {
  const prefix = lang.slice(0, 2).toLowerCase()
  const voices = synth.getVoices()
  return (
    voices.find((voice) => voice.lang.toLowerCase().startsWith(prefix) && voice.localService) ??
    voices.find((voice) => voice.lang.toLowerCase().startsWith(prefix)) ??
    null
  )
}

/** Queue one utterance per language run. `cancelled` stops the queue without a further utterance. */
export function speakWebSpeechSegments(options: {
  text: string
  rate: number
  synth: WebSpeechSynth
  createUtterance: (text: string) => WebSpeechUtterance
  cancelled: () => boolean
}): Promise<void> {
  const segments = segmentNativeChatSpeech(options.text).flatMap((segment) =>
    chunkNativeChatSpeech(segment.text, 800).map((text) => ({ text, lang: segment.lang }))
  )
  if (segments.length === 0 || options.cancelled()) {
    return Promise.resolve()
  }
  return new Promise((resolve) => {
    let index = 0
    const next = (): void => {
      if (options.cancelled() || index >= segments.length) {
        resolve()
        return
      }
      const segment = segments[index]
      index += 1
      if (!segment) {
        resolve()
        return
      }
      const utterance = options.createUtterance(segment.text)
      utterance.lang = segment.lang
      utterance.rate = options.rate
      utterance.voice = voiceFor(options.synth, segment.lang)
      utterance.onend = next
      utterance.onerror = next
      options.synth.speak(utterance)
    }
    next()
  })
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

function playMp3(bytes: Uint8Array, token: number): Promise<void> {
  if (token !== speechGeneration) {
    return Promise.resolve()
  }
  const audioBuffer = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(audioBuffer).set(bytes)
  const url = URL.createObjectURL(new Blob([audioBuffer], { type: 'audio/mpeg' }))
  const audio = new Audio(url)
  currentAudio = audio
  return new Promise((resolve, reject) => {
    const done = (): void => {
      URL.revokeObjectURL(url)
      if (currentAudio === audio) {
        currentAudio = null
      }
      resolve()
    }
    audio.onended = done
    audio.onerror = () => {
      URL.revokeObjectURL(url)
      if (currentAudio === audio) {
        currentAudio = null
      }
      reject(new Error('Could not play speech audio'))
    }
    void audio.play().catch((error: unknown) => {
      URL.revokeObjectURL(url)
      reject(error instanceof Error ? error : new Error('Could not play speech audio'))
    })
  })
}

async function speakWithEdge(
  text: string,
  settings: ResolvedNativeChatSpeech,
  token: number
): Promise<void> {
  const result = await window.api.speech.synthesize({
    text,
    voice: settings.voice,
    rate: settings.rate
  })
  if (token !== speechGeneration) {
    return
  }
  if (!result?.audioBase64) {
    throw new Error('Neural speech returned no audio')
  }
  await playMp3(decodeBase64(result.audioBase64), token)
}

async function speakWithSystem(text: string, rate: number, token: number): Promise<void> {
  const synth = window.speechSynthesis
  if (!synth) {
    return
  }
  // Chromium drops an utterance spoken in the same turn as cancel().
  await new Promise((resolve) => {
    window.setTimeout(resolve, 0)
  })
  if (token !== speechGeneration) {
    return
  }
  await speakWebSpeechSegments({
    text,
    rate,
    synth: {
      cancel: () => synth.cancel(),
      getVoices: () => synth.getVoices(),
      speak: (utterance) => synth.speak(utterance as SpeechSynthesisUtterance)
    },
    createUtterance: (value) => new SpeechSynthesisUtterance(value) as WebSpeechUtterance,
    cancelled: () => token !== speechGeneration
  })
}

/** The hover button and the message menu share this: a second press on the same reply stops it. */
export function toggleNativeChatMessageSpeech(input: {
  messageId: string
  markdown: string
  settings: ResolvedNativeChatSpeech
}): void {
  if (speakingMessageId === input.messageId) {
    stopNativeChatSpeech()
    return
  }
  void speakNativeChatMessage(input)
}

export async function speakNativeChatMessage(input: {
  messageId: string
  markdown: string
  settings: ResolvedNativeChatSpeech
}): Promise<void> {
  const text = nativeChatTextForSpeech(withoutNativeChatVisualDirectiveLines(input.markdown))
  if (!text) {
    return
  }
  stopNativeChatSpeech()
  const token = speechGeneration
  setSpeaking(input.messageId)
  try {
    if (input.settings.engine === 'edge') {
      try {
        await speakWithEdge(text, input.settings, token)
        return
      } catch (error) {
        console.error('Neural speech failed, using the system voice', error)
      }
    }
    if (token !== speechGeneration) {
      return
    }
    await speakWithSystem(text, input.settings.rate, token)
  } finally {
    if (token === speechGeneration) {
      setSpeaking(null)
    }
  }
}
