import type { Extension as FromMarkdownExtension } from 'mdast-util-from-markdown'
import type { Construct, Extension, State, Tokenizer } from 'micromark-util-types'
import type { Processor } from 'unified'
import {
  CODEX_FILE_CITATION_MAX_LENGTH,
  CODEX_FILE_CITATION_START,
  parseCodexFileCitation
} from '../../../../../shared/native-chat/file-access/codex-file-citation'
import { createNativeChatFileHref } from '../../../../../shared/native-chat/file-access/native-chat-href-routing'

declare module 'micromark-util-types' {
  // oxlint-disable-next-line typescript/consistent-type-definitions -- declaration merging needs an interface.
  interface TokenTypeMap {
    codexFileCitation: 'codexFileCitation'
  }
}

const TOKEN = 'codexFileCitation'
const HORIZONTAL_TAB = -2
const VIRTUAL_SPACE = -1

const tokenize: Tokenizer = (effects, ok, nok) => {
  let text = ''
  let quoted = false

  const read: State = (code) => {
    if (code === null || code < HORIZONTAL_TAB || text.length >= CODEX_FILE_CITATION_MAX_LENGTH) {
      return nok(code)
    }
    if (code === VIRTUAL_SPACE) {
      effects.consume(code)
      return read
    }
    const next = code === HORIZONTAL_TAB ? '\t' : String.fromCharCode(code)
    if (
      text.length < CODEX_FILE_CITATION_START.length &&
      next !== CODEX_FILE_CITATION_START[text.length]
    ) {
      return nok(code)
    }
    if (next === '"' && (!quoted || !text.endsWith('\\'))) {
      quoted = !quoted
    }
    text += next
    effects.consume(code)
    if (next === '}' && !quoted) {
      effects.exit(TOKEN)
      return parseCodexFileCitation(text)?.end === text.length ? ok : nok
    }
    return read
  }

  return (code) => {
    effects.enter(TOKEN)
    return read(code)
  }
}

const construct: Construct = { name: TOKEN, tokenize }
const micromark: Extension = { text: { 58: construct } }
const fromMarkdown: FromMarkdownExtension = {
  enter: {
    [TOKEN](token) {
      const source = this.sliceSerialize(token)
      const citation = parseCodexFileCitation(source)
      const label = { type: 'text' as const, value: citation?.label ?? source }
      const insideLink = this.stack.some(({ type }) => type === 'link' || type === 'linkReference')
      this.enter(
        citation && !insideLink
          ? {
              type: 'link',
              url: createNativeChatFileHref(citation.path, 'literal'),
              children: [label]
            }
          : label,
        token
      )
    }
  },
  exit: {
    [TOKEN](token) {
      this.exit(token)
    }
  }
}

export function remarkNativeChatCodexFileCitations(this: Processor): void {
  const data = this.data()
  data.micromarkExtensions = [...(data.micromarkExtensions ?? []), micromark]
  data.fromMarkdownExtensions = [...(data.fromMarkdownExtensions ?? []), fromMarkdown]
}
