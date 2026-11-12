/// <reference types="remark-parse" />

import type { Root } from 'mdast'
import type {
  Code,
  Construct,
  State,
  Token,
  TokenizeContext,
  Tokenizer
} from 'micromark-util-types'
import type { Processor } from 'unified'
import type { VFile } from 'vfile'
import {
  endsDollarAmount,
  isCitationBracketMath,
  markdownMathCloser,
  rejectsSingleDollarClose,
  rejectsSingleDollarOpen
} from '../../../../shared/markdown-math-rules'
import { chatMathFromMarkdown, transformChatMath } from './chat-markdown-math-nodes'

declare module 'micromark-util-types' {
  // oxlint-disable-next-line typescript/consistent-type-definitions -- Declaration merging registers parser tokens.
  interface TokenTypeMap {
    chatMath: 'chatMath'
    chatMathMarker: 'chatMathMarker'
    chatMathData: 'chatMathData'
  }
  // oxlint-disable-next-line typescript/consistent-type-definitions -- Declaration merging extends upstream tokens.
  interface Token {
    chatMath?: { opener: string; closer: string; flow: boolean; closed: boolean }
  }
}

const lineEnding = (code: Code): boolean => code !== null && code < -2
const digit = (code: Code): code is number => code !== null && code >= 48 && code <= 57
/** The character a code stands for; tabs, virtual spaces and line endings read as a space. */
const charOf = (code: Code): string | undefined =>
  code === null ? undefined : code < 0 ? ' ' : String.fromCharCode(code)

type ExhaustedSearch = { from: number; to: number; last: Map<number, number> }

function construct(flow: boolean): Construct {
  const searches = new WeakMap<TokenizeContext, Map<string, ExhaustedSearch>>()
  const tokenize: Tokenizer = function (effects, ok, nok) {
    const previousChar = () => charOf(this.previous)
    const knowledge = flow ? undefined : (searches.get(this) ?? new Map<string, ExhaustedSearch>())
    if (knowledge) {
      searches.set(this, knowledge)
    }
    const observed = new Map<number, number>()
    let family = ''
    let opener = ''
    let closer = ''
    let body = ''
    let token: Token
    let escaped = false
    let candidate: Token
    let closeSize = 0
    let closePrevious: string | undefined
    const continuation: Construct = {
      partial: true,
      tokenize(e, yes, no) {
        const canContinue = () => !this.parser.lazy[this.now().line]
        return (code) => {
          e.enter('lineEnding')
          e.consume(code)
          e.exit('lineEnding')
          return (next) => (canContinue() ? yes(next) : no(next))
        }
      }
    }
    const closing: Construct = { partial: true, tokenize: tokenizeClose }
    const exhausted = (code: Code): State | undefined => {
      if (knowledge) {
        const end = this.now().offset
        const previous = knowledge.get(family)
        if (!previous) {
          knowledge.set(family, { from: token.start.offset, to: end, last: observed })
        } else {
          for (const [length, position] of observed) {
            previous.last.set(length, Math.max(previous.last.get(length) ?? -1, position))
          }
          if (end >= previous.to) {
            previous.from =
              end === previous.to ? Math.min(previous.from, token.start.offset) : token.start.offset
            previous.to = end
          }
        }
      }
      return nok(code)
    }
    return start

    function start(code: Code): State | undefined {
      token = effects.enter('chatMath')
      effects.enter('chatMathMarker')
      effects.consume(code)
      opener = code === 36 ? '$' : '\\'
      return opening
    }
    function opening(code: Code): State | undefined {
      if (opener.startsWith('$') && code === 36) {
        opener += '$'
        effects.consume(code)
        return opening
      }
      if (opener === '\\') {
        if (code !== 91 && (flow || code !== 40)) {
          return nok(code)
        }
        opener += String.fromCharCode(code)
        effects.consume(code)
      } else if (flow && opener.length < 2) {
        return nok(code)
      }
      closer = markdownMathCloser(opener)
      effects.exit('chatMathMarker')
      token.chatMath = { opener, closer, flow, closed: false }
      family = opener.startsWith('$') && opener.length > 1 ? '$$' : opener
      const searched = knowledge?.get(family)
      if (
        searched &&
        token.start.offset >= searched.from &&
        token.start.offset < searched.to &&
        (!opener.startsWith('$') || (searched.last.get(opener.length) ?? -1) <= token.start.offset)
      ) {
        return nok(code)
      }
      return opener.startsWith('$') ? afterOpen(code) : between
    }
    function afterOpen(code: Code): State | undefined {
      if (opener === '$' && rejectsSingleDollarOpen(charOf(code))) {
        return nok(code)
      }
      if (opener === '$' && digit(code)) {
        effects.enter('chatMathData')
        return leadingNumber(code)
      }
      return between(code)
    }
    function leadingNumber(code: Code): State | undefined {
      if (digit(code) || code === 44 || code === 46) {
        effects.consume(code)
        body += String.fromCharCode(code)
        return leadingNumber
      }
      if (endsDollarAmount(charOf(code))) {
        return nok(code)
      }
      return data(code)
    }
    function between(code: Code): State | undefined {
      if (code === null) {
        return flow ? finish(code) : exhausted(code)
      }
      if (lineEnding(code)) {
        if (flow) {
          return effects.attempt(continuation, continued, finish)(code)
        }
        if (opener === '\\(') {
          return exhausted(code)
        }
        effects.enter('lineEnding')
        effects.consume(code)
        effects.exit('lineEnding')
        body += '\n'
        return between
      }
      if (code === 36 && opener.startsWith('$')) {
        closePrevious = previousChar()
        candidate = effects.enter('chatMathMarker')
        closeSize = 0
        return dollarClose(code)
      }
      if (code === closer.charCodeAt(0)) {
        return effects.attempt(closing, flow ? trailing : closed, dataStart)(code)
      }
      return dataStart(code)
    }
    function continued(code: Code): State | undefined {
      body += '\n'
      return between(code)
    }
    function dollarClose(code: Code): State | undefined {
      if (code === 36 && (opener !== '$' || closeSize === 0)) {
        effects.consume(code)
        closeSize++
        return dollarClose
      }
      if (closeSize !== closer.length) {
        if (!flow) {
          observed.set(closeSize, candidate.start.offset)
        }
        candidate.type = 'chatMathData'
        effects.exit('chatMathData')
        body += '$'.repeat(closeSize)
        return between(code)
      }
      if (opener === '$' && rejectsSingleDollarClose(closePrevious, charOf(code))) {
        return nok(code)
      }
      effects.exit('chatMathMarker')
      return flow ? trailing(code) : closed(code)
    }
    function trailing(code: Code): State | undefined {
      if (code === 32 || code === -2 || code === -1) {
        effects.enter('whitespace')
        effects.consume(code)
        effects.exit('whitespace')
        return trailing
      }
      return code === null || lineEnding(code) ? closed(code) : nok(code)
    }
    function closed(code: Code): State | undefined {
      if (token.chatMath) {
        token.chatMath.closed = true
      }
      return finish(code)
    }
    function dataStart(code: Code): State | undefined {
      effects.enter('chatMathData')
      if (code === null) {
        return data(code)
      }
      if (!flow && code === 96) {
        return exhausted(code)
      }
      effects.consume(code)
      body += code < 0 ? ' ' : String.fromCharCode(code)
      escaped = code === 92
      return data
    }
    function data(code: Code): State | undefined {
      if (code === null || lineEnding(code) || (!escaped && code === closer.charCodeAt(0))) {
        effects.exit('chatMathData')
        return between(code)
      }
      if (!flow && code === 96) {
        return exhausted(code)
      }
      effects.consume(code)
      body += code < 0 ? ' ' : String.fromCharCode(code)
      escaped = !escaped && code === 92
      return data
    }
    function finish(code: Code): State | undefined {
      if ((!flow && !token.chatMath?.closed) || isCitationBracketMath(opener, body)) {
        return nok(code)
      }
      effects.exit('chatMath')
      return ok(code)
    }
    function tokenizeClose(
      closeEffects: Parameters<Tokenizer>[0],
      closeOk: State,
      closeNok: State
    ): State {
      let closeIndex = 0
      closeEffects.enter('chatMathMarker')
      return sequence
      function sequence(code: Code): State | undefined {
        if (closeIndex < closer.length) {
          if (code !== closer.charCodeAt(closeIndex)) {
            return closeNok(code)
          }
          closeEffects.consume(code)
          closeIndex++
          return sequence
        }
        closeEffects.exit('chatMathMarker')
        return closeOk(code)
      }
    }
  }
  return {
    name: flow ? 'chatMathFlow' : 'chatMathText',
    concrete: flow,
    tokenize,
    previous(code) {
      return code !== 36 || this.events.at(-1)?.[1].type === 'characterEscape'
    }
  }
}

/** Chat grammar consumes original source; the splitter and renderer share these constructs. */
export function remarkChatMath(this: Processor): (tree: Root, file: VFile) => void {
  const data = this.data()
  const flow = construct(true)
  const text = construct(false)
  ;(data.micromarkExtensions ??= []).push({
    flow: { 36: flow, 92: flow },
    text: { 36: text, 92: text }
  })
  ;(data.fromMarkdownExtensions ??= []).push(chatMathFromMarkdown)
  return transformChatMath
}
