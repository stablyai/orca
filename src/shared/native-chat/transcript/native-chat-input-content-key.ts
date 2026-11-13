import type { NativeChatMessage } from '../native-chat-types'
import {
  nativeChatInputTextDigest,
  type NativeChatSourcePending
} from './native-chat-input-content'
import { resolveNativeChatTranscriptAgent } from '../native-chat-agent-support'
import { buildNativeChatPasteBytes } from '../input/native-chat-paste-bytes'
import {
  BRACKETED_PASTE_START,
  BRACKETED_PASTE_END
} from '../../terminal/input/terminal-bracketed-paste-text'

function submittedText(text: string): string {
  const bytes = buildNativeChatPasteBytes(text)
  return bytes.startsWith(BRACKETED_PASTE_START)
    ? bytes.slice(BRACKETED_PASTE_START.length, -BRACKETED_PASTE_END.length)
    : bytes
}

// Rust White_Space differs from JavaScript trim (notably U+0085 and U+FEFF).
function rustTrim(text: string): string {
  return text.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '')
}

function ompPastedText(text: string): string {
  return (
    text
      .replace(/\r\n?/g, '\n')
      .normalize('NFC')
      .replace(/\t/g, '   ')
      // oxlint-disable-next-line no-control-regex -- Match the producer's persisted paste sanitizer exactly.
      .replace(/[\u0000-\u0009\u000b-\u001f]/g, '')
  )
}

type ExpectedSourceInput = { keys: readonly string[] }
const pendingKeys = new WeakMap<NativeChatSourcePending, ExpectedSourceInput>()
const messageKeys = new WeakMap<NonNullable<NativeChatMessage['inputContent']>, string>()

function expectedSourceInput(pending: NativeChatSourcePending): ExpectedSourceInput {
  const cached = pendingKeys.get(pending)
  if (cached) {
    return cached
  }
  if (pending.imagePaths?.length) {
    return { keys: [] }
  }
  const provider = resolveNativeChatTranscriptAgent(pending.sourceAgent)
  let body = submittedText(pending.text)
  if (
    provider === 'omp' &&
    buildNativeChatPasteBytes(pending.text).startsWith(BRACKETED_PASTE_START)
  ) {
    body = ompPastedText(body)
  }
  if (provider === 'opencode' || provider === 'claude') {
    body = body.replace(/\r\n?/g, '\n')
  }
  let text = body
  if (provider === 'omp') {
    text = text.trim()
  }
  if (provider === 'codex') {
    text = text.replace(/\r\n?/g, '\n')
    if (buildNativeChatPasteBytes(pending.text).startsWith(BRACKETED_PASTE_START)) {
      // Pasted text passes through the composer's control sanitizer; typed short input does not.
      // oxlint-disable-next-line no-control-regex -- Match the producer's persisted paste sanitizer exactly.
      text = text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '')
    }
    text = rustTrim(text)
  }
  const texts =
    provider === 'opencode' &&
    buildNativeChatPasteBytes(pending.text).startsWith(BRACKETED_PASTE_START)
      ? [false, true].map((full) => opencodeFrame(body, full))
      : [text]
  const expected = {
    keys: [
      ...new Set(texts.map((value) => sourceKey(provider, nativeChatInputTextDigest(value), [])))
    ]
  }
  pendingKeys.set(pending, expected)
  return expected
}

export function nativeChatSourcePendingKeys(pending: NativeChatSourcePending): readonly string[] {
  return expectedSourceInput(pending).keys
}

function sourceKey(provider: unknown, digest: string, images: readonly string[]): string {
  return JSON.stringify([provider, digest, images])
}

function opencodeFrame(text: string, full: boolean): string {
  const normalized = text
    .replace(
      // oxlint-disable-next-line no-control-regex -- Match the producer paste sanitizer.
      /(?:\x1b\[|\x9b)[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]?|(?:\x1b[P\]X^_]|[\x90\x98\x9d-\x9f])[^\x07\x1b\x9c]*(?:\x07|\x1b\\|\x9c)?|\x1b[\x20-\x2f]*[\x30-\x7e]?/g,
      ''
    )
    .replace(/\r\n?/g, '\n')
  const trimmed = normalized.trim()
  return !full && (trimmed.length > 150 || trimmed.split('\n').length >= 3) ? trimmed : normalized
}

export function nativeChatSourceMessageKey(message: NativeChatMessage): string | null {
  const content = message.inputContent
  if (message.role !== 'user' || message.source !== 'transcript' || !content) {
    return null
  }
  let key = messageKeys.get(content)
  if (!key) {
    key = sourceKey(content.provider, content.textDigest, content.images)
    messageKeys.set(content, key)
  }
  return key
}
