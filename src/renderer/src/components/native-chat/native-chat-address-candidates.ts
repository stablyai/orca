import { CHAT_ADDRESS_PREVIEW_LIMIT } from '../../../../shared/chat-address-preview'

const MAX_SOURCE_LENGTH = 8_192
const SCHEME = /^(?:https?:\/\/|file:\/\/)/i
const LOCAL_PATH = /^(?:\/(?!\/)|[a-z]:[\\/])/i
const ADDRESS_TOKEN = /(?:https?:\/\/|file:\/\/)[^\s<>"'`]+|(?:[a-z]:[\\/]|\/(?!\/))[^\s<>"'`]+/gi

function trimProsePunctuation(value: string): string {
  let source = value.replace(/[.,;!?]+$/, '')
  for (const [open, close] of [
    ['(', ')'],
    ['[', ']'],
    ['{', '}']
  ]) {
    while (source.endsWith(close) && source.split(close).length > source.split(open).length) {
      source = source.slice(0, -1)
    }
  }
  return source
}

function isAddress(source: string): boolean {
  if (source.length > MAX_SOURCE_LENGTH || /\p{Cc}/u.test(source)) {
    return false
  }
  if (SCHEME.test(source)) {
    try {
      const url = new URL(source)
      return ['http:', 'https:', 'file:'].includes(url.protocol)
    } catch {
      return false
    }
  }
  // Do not turn slash commands such as /help into filesystem reads.
  return LOCAL_PATH.test(source) && /[\\/.]/.test(source.slice(1))
}

/** Only called for user-pasted text, never for agent output or restored drafts. */
export function pastedAddressCandidates(text: string): string[] {
  const sources = new Set<string>()
  const add = (source: string): void => {
    if (sources.size < CHAT_ADDRESS_PREVIEW_LIMIT && isAddress(source)) {
      sources.add(source)
    }
  }
  for (const line of text.split(/\r?\n/)) {
    if (sources.size === CHAT_ADDRESS_PREVIEW_LIMIT) {
      break
    }
    const value = line.trim()
    if (!value) {
      continue
    }
    // A copied URL is authoritative; trailing punctuation can be part of its signature.
    if (SCHEME.test(value) && !/\s/.test(value)) {
      add(value)
      continue
    }
    // A path copied by an OS file manager can contain unquoted spaces.
    if (LOCAL_PATH.test(value) && !SCHEME.test(value)) {
      add(value)
      continue
    }
    const remainder = value.replace(/(["'`])([^\r\n]*?)\1/g, (match, _quote, contents: string) => {
      if (isAddress(contents)) {
        add(contents)
        return ' '.repeat(match.length)
      }
      return match
    })
    for (const match of remainder.matchAll(ADDRESS_TOKEN)) {
      const before = match.index === 0 ? '' : remainder[match.index - 1]
      if (before && !/[\s([<{=:]/.test(before)) {
        continue
      }
      add(trimProsePunctuation(match[0]))
    }
  }
  return [...sources]
}

/** A longer edited URL/path must not keep the old resource alive by substring match. */
export function draftContainsAddress(draft: string, source: string): boolean {
  let offset = 0
  while (offset <= draft.length - source.length) {
    const index = draft.indexOf(source, offset)
    if (index === -1) {
      return false
    }
    const before = draft[index - 1]
    const rest = draft.slice(index + source.length)
    const endsHere = /^(?:$|[\s"'`)\]}>]|[.,;!?](?=$|[\s"'`)\]}>]))/.test(rest)
    if ((!before || /[\s"'`([<{=:]/.test(before)) && endsHere) {
      return true
    }
    offset = index + source.length
  }
  return false
}
