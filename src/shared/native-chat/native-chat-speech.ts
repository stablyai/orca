/** How an assistant reply is read aloud. Absent fields keep the defaults. */
export type NativeChatSpeechSettings = {
  /** Absent means the Speak button is shown. */
  enabled?: boolean
  /** Absent means the operating-system voice. `edge` uses Microsoft neural voices. */
  engine?: NativeChatSpeechEngine
  /** Edge voice. Absent means Svetlana. */
  voice?: NativeChatSpeechVoice
  /** 0.5–2. Absent means 1. */
  rate?: number
  /** Read each new assistant reply when it finishes. Absent means off. */
  auto?: boolean
}

export type NativeChatSpeechEngine = 'web-speech' | 'edge'
export type NativeChatSpeechVoice = 'ru-RU-SvetlanaNeural' | 'ru-RU-DmitryNeural'

export type ResolvedNativeChatSpeech = {
  enabled: boolean
  engine: NativeChatSpeechEngine
  voice: NativeChatSpeechVoice
  rate: number
  auto: boolean
}

export type NativeChatSpeechSegment = {
  text: string
  lang: 'ru-RU' | 'en-US'
}

export type NativeChatEdgeSpeechRequest = {
  text: string
  voice: NativeChatSpeechVoice
  rate: number
}

const DEFAULT_VOICE: NativeChatSpeechVoice = 'ru-RU-SvetlanaNeural'
const RUSSIAN_LETTER = /[\u0400-\u04FF\u0500-\u052F]/
const ENGLISH_LETTER = /[A-Za-z]/

export function normalizeNativeChatSpeechSettings(
  value: unknown
): NativeChatSpeechSettings | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }
  const record = value as Record<string, unknown>
  const normalized: NativeChatSpeechSettings = {}
  if (record.enabled === false) {
    normalized.enabled = false
  }
  if (record.engine === 'edge') {
    normalized.engine = 'edge'
  }
  if (record.voice === 'ru-RU-DmitryNeural') {
    normalized.voice = 'ru-RU-DmitryNeural'
  }
  if (typeof record.rate === 'number' && Number.isFinite(record.rate)) {
    const rate = Math.min(2, Math.max(0.5, Math.round(record.rate * 10) / 10))
    if (rate !== 1) {
      normalized.rate = rate
    }
  }
  if (record.auto === true) {
    normalized.auto = true
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined
}

export function resolveNativeChatSpeechSettings(value: unknown): ResolvedNativeChatSpeech {
  const normalized = normalizeNativeChatSpeechSettings(value)
  return {
    enabled: normalized?.enabled !== false,
    engine: normalized?.engine ?? 'web-speech',
    voice: normalized?.voice ?? DEFAULT_VOICE,
    rate: normalized?.rate ?? 1,
    auto: normalized?.auto === true
  }
}

const HTML_TAG = /<\/?[A-Za-z][^<>\n]*>/g

/**
 * Holds fenced and inline code so a later HTML strip cannot eat generics such as `Promise<void>`.
 * The held spans go back before markdown is unwrapped, so the code words are still spoken.
 */
function holdSpeechCode(markdown: string): { text: string; held: string[] } {
  const held: string[] = []
  const text = markdown.replace(/```[\w-]*[ \t]*\n?[\s\S]*?```|`[^`]+`/g, (span) => {
    const token = `\uE000${held.length}\uE001`
    held.push(span)
    return token
  })
  return { text, held }
}

/** Words to speak: markdown markers go, the words under them stay, including code. */
export function nativeChatTextForSpeech(markdown: string): string {
  const { text, held } = holdSpeechCode(markdown)
  return text
    .replace(HTML_TAG, ' ')
    .replace(/\uE000(\d+)\uE001/g, (_match, index: string) => held[Number(index)] ?? '')
    .replace(/```[\w-]*[ \t]*\n?([\s\S]*?)```/g, (_match, code: string) => `\n${code}\n`)
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(^|[\s])\*([^*\n]+)\*(?=[\s.,!?]|$)/g, '$1$2')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function letterLanguage(character: string): 'ru' | 'en' | null {
  if (RUSSIAN_LETTER.test(character)) {
    return 'ru'
  }
  if (ENGLISH_LETTER.test(character)) {
    return 'en'
  }
  return null
}

function splitTrailingGap(value: string): { keep: string; gap: string } {
  let index = value.length
  while (index > 0 && letterLanguage(value[index - 1] ?? '') === null) {
    index -= 1
  }
  return { keep: value.slice(0, index), gap: value.slice(index) }
}

/**
 * Russian and English runs stay separate so each can use its own voice.
 * Spaces between two English words stay in the English run (`pull request`).
 */
export function segmentNativeChatSpeech(text: string): NativeChatSpeechSegment[] {
  const chunks: { lang: 'ru' | 'en'; text: string }[] = []
  let lang: 'ru' | 'en' | null = null
  let buffer = ''
  let pending = ''

  const push = (): void => {
    if (!lang || buffer.trim().length === 0) {
      buffer = ''
      return
    }
    const last = chunks.at(-1)
    if (last && last.lang === lang) {
      last.text += buffer
    } else {
      chunks.push({ lang, text: buffer })
    }
    buffer = ''
  }

  for (const character of text) {
    const next = letterLanguage(character)
    if (!next) {
      if (lang) {
        buffer += character
      } else {
        pending += character
      }
      continue
    }
    if (lang && next !== lang) {
      const split = splitTrailingGap(buffer)
      buffer = split.keep
      push()
      buffer = split.gap
    }
    if (!lang && pending) {
      buffer = pending
      pending = ''
    }
    lang = next
    buffer += character
  }
  push()
  if (chunks.length === 0) {
    const spoken = text.trim()
    return spoken ? [{ text: spoken, lang: 'en-US' }] : []
  }
  return chunks.map((chunk) => ({
    text: chunk.text,
    lang: chunk.lang === 'ru' ? 'ru-RU' : 'en-US'
  }))
}

/** Break a long reply on a newline or space so one utterance stays speakable. */
export function chunkNativeChatSpeech(text: string, limit: number): string[] {
  const chunks: string[] = []
  let rest = text.trim()
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit)
    if (cut < limit / 2) {
      cut = rest.lastIndexOf(' ', limit)
    }
    if (cut < limit / 2) {
      cut = limit
    }
    const chunk = rest.slice(0, cut).trim()
    if (chunk) {
      chunks.push(chunk)
    }
    rest = rest.slice(cut).trim()
  }
  if (rest) {
    chunks.push(rest)
  }
  return chunks
}
