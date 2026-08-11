import type { marked } from 'marked'
import { createTiptapMarkedFacade } from './tiptap-marked-facade'

export type RichMarkdownSourceKind =
  | 'literal'
  | 'inline-html'
  | 'block-html'
  | 'document-link'
  | 'html-superscript-link'

const TRANSPORT_PREFIX = '[[ORCA_RICH_MD:'
const TRANSPORT_SUFFIX = ']]'
const KEY_PATTERN = /^[a-f0-9]{32}$/
const TRANSPORT_BODY_PATTERN =
  /^ORCA_RICH_MD:[a-f0-9]{32}:(?:literal|inline-html|block-html|document-link|html-superscript-link):/
const LEGACY_PREFIXES = ['ORCA_RAW_HTML_INLINE:', 'ORCA_RAW_HTML_BLOCK:', 'ORCA_DOC_LINK:'] as const

export type RichMarkdownSourceTransport = {
  readonly key: string
  readonly authoredPrefix: string
  create: (kind: RichMarkdownSourceKind, value: string) => string
  match: (source: string, kind: RichMarkdownSourceKind) => { raw: string; value: string } | null
  startFor: (kind: RichMarkdownSourceKind) => string
}

export function isLegacyRichMarkdownTransportBody(value: string): boolean {
  return LEGACY_PREFIXES.some((prefix) => value.startsWith(prefix))
}

export function isReservedRichMarkdownTransportBody(value: string): boolean {
  // Why: a foreign editor's valid keyed envelope is authored text here, not
  // a document link whose target happens to resemble transport metadata.
  return isLegacyRichMarkdownTransportBody(value) || TRANSPORT_BODY_PATTERN.test(value)
}

export type RichMarkdownEditorCodec = {
  transport: RichMarkdownSourceTransport
  marked: typeof marked
}

export function createRichMarkdownEditorCodec(key = createCodecKey()): RichMarkdownEditorCodec {
  return {
    transport: createRichMarkdownSourceTransport(key),
    marked: createTiptapMarkedFacade()
  }
}

export function createRichMarkdownSourceTransport(key: string): RichMarkdownSourceTransport {
  if (!KEY_PATTERN.test(key)) {
    throw new Error('Rich Markdown transport keys must be 128-bit lowercase hex values')
  }
  const authoredPrefix = `${TRANSPORT_PREFIX}${key}:`
  const startFor = (kind: RichMarkdownSourceKind): string => `${authoredPrefix}${kind}:`

  return {
    key,
    authoredPrefix,
    startFor,
    create: (kind, value) => `${startFor(kind)}${encodeURIComponent(value)}${TRANSPORT_SUFFIX}`,
    match: (source, kind) => {
      const prefix = startFor(kind)
      if (!source.startsWith(prefix)) {
        return null
      }
      const endIndex = source.indexOf(TRANSPORT_SUFFIX, prefix.length)
      if (endIndex === -1) {
        return null
      }
      const raw = source.slice(0, endIndex + TRANSPORT_SUFFIX.length)
      try {
        return {
          raw,
          value: decodeURIComponent(source.slice(prefix.length, endIndex))
        }
      } catch {
        return null
      }
    }
  }
}

function createCodecKey(): string {
  const bytes = new Uint8Array(16)
  globalThis.crypto.getRandomValues(bytes)
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}
