import type { Nodes, Root } from 'mdast'
import type { Extension as FromMarkdownExtension } from 'mdast-util-from-markdown'
import type { Code, Construct, State, Token, Tokenizer } from 'micromark-util-types'
import type { Processor } from 'unified'
import type { VFile } from 'vfile'
import type {} from 'remark-parse'
import type {} from 'remark-math'

declare module 'vfile' {
  // oxlint-disable-next-line typescript/consistent-type-definitions -- Declaration merging extends upstream file metadata.
  interface DataMap {
    chatMathSources: Map<number, string>
  }
}

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
const whitespace = (code: Code): boolean => code === null || code < 0 || code === 32
const digit = (code: Code): boolean => code !== null && code >= 48 && code <= 57

function construct(flow: boolean): Construct {
  const tokenize: Tokenizer = function (effects, ok, nok) {
    const lazyLines = this.parser.lazy
    const currentLine = () => this.now().line
    let opener = ''
    let closer = ''
    let body = ''
    let token: Token
    let escaped = false
    let closeIndex = 0
    let inlineClosing = false
    const closing: Construct = { partial: true, tokenize: tokenizeClose }
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
        closer = code === 91 ? '\\]' : '\\)'
      } else {
        if (flow && opener.length < 2) {
          return nok(code)
        }
        closer = opener
      }
      effects.exit('chatMathMarker')
      token.chatMath = { opener, closer, flow, closed: false }
      return opener.startsWith('$') ? afterOpen(code) : between
    }
    function afterOpen(code: Code): State | undefined {
      if (opener === '$' && whitespace(code)) {
        return nok(code)
      }
      return between(code)
    }
    function between(code: Code): State | undefined {
      if (code === null) {
        return finish(code)
      }
      if (lineEnding(code)) {
        if (!flow && (opener === '$' || opener === '\\(')) {
          return finish(code)
        }
        effects.enter('lineEnding')
        effects.consume(code)
        effects.exit('lineEnding')
        body += '\n'
        return flow ? continuation : between
      }
      if (code === closer.charCodeAt(0)) {
        return effects.attempt(closing, finish, noClose)(code)
      }
      return dataStart(code)
    }
    function noClose(code: Code): State | undefined {
      return opener === '$' || inlineClosing ? nok(code) : dataStart(code)
    }
    function continuation(code: Code): State | undefined {
      // A concrete flow consumes blank lines, but cannot escape its Markdown container.
      return lazyLines[currentLine()] ? finish(code) : between(code)
    }
    function dataStart(code: Code): State | undefined {
      effects.enter('chatMathData')
      if (code === null) {
        return data(code)
      }
      if (!flow && code === 96) {
        return nok(code)
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
        return nok(code)
      }
      effects.consume(code)
      body += code < 0 ? ' ' : String.fromCharCode(code)
      escaped = !escaped && code === 92
      return data
    }
    function finish(code: Code): State | undefined {
      if (opener === '\\[' && /^[\d\s,]+$/.test(body)) {
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
      closeIndex = 0
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
        if (opener.startsWith('$') && code === 36) {
          return closeNok(code)
        }
        if (opener === '$' && (/\s/.test(body.at(-1) ?? '') || digit(code))) {
          return closeNok(code)
        }
        if (
          opener === '$' &&
          /^[+-]?\d[\d,]*(?:\.\d+)?(?:[^\p{ASCII}]|\s)/u.test(body) &&
          !/[\\_^=<>+*/{}-]/.test(body)
        ) {
          return closeNok(code)
        }
        closeEffects.exit('chatMathMarker')
        return flow ? trailing(code) : closed(code)
      }
      function trailing(code: Code): State | undefined {
        if (code === 32 || code === -2 || code === -1) {
          closeEffects.enter('whitespace')
          closeEffects.consume(code)
          closeEffects.exit('whitespace')
          return trailing
        }
        if (code === null || lineEnding(code)) {
          return closed(code)
        }
        inlineClosing = true
        return closeNok(code)
      }
      function closed(code: Code): State | undefined {
        if (token.chatMath) {
          token.chatMath.closed = true
        }
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

const fromMarkdown: FromMarkdownExtension = {
  enter: {
    chatMath(token) {
      this.enter({ type: 'inlineMath', value: '' }, token)
      this.buffer()
    }
  },
  exit: {
    chatMathData(token) {
      this.config.enter.data.call(this, token)
      this.config.exit.data.call(this, token)
    },
    chatMath(token) {
      const value = this.resume()
      const node = this.stack.at(-1)
      if (node?.type !== 'inlineMath' || !token.chatMath) {
        return
      }
      const { opener, closer, closed, flow } = token.chatMath
      node.value = closed ? value.trim() : opener + value
      node.data = {
        hName: flow ? 'div' : 'span',
        hProperties: closed
          ? {
              className: ['language-math', flow ? 'math-display' : 'math-inline']
            }
          : { className: ['whitespace-pre-wrap'] },
        hChildren: [{ type: 'text', value: node.value }],
        mathSource: opener + value + (closed ? closer : ''),
        mathComplete: closed,
        mathDisplay: opener !== '$' && opener !== '\\('
      }
      this.exit(token)
    }
  }
}

function displayMath(node: Nodes): void {
  if (node.type === 'link' || node.type === 'image') {
    return
  }
  if (
    node.type === 'paragraph' &&
    node.children.every(
      (child) =>
        (child.type === 'text' && !child.value.trim()) ||
        child.type === 'break' ||
        (child.type === 'inlineMath' &&
          child.data?.mathComplete === true &&
          child.data?.mathDisplay)
    )
  ) {
    for (const child of node.children) {
      if (child.type === 'inlineMath' && child.data?.hProperties?.className) {
        child.data.hProperties.className = ['language-math', 'math-display']
      }
    }
  }
  if ('children' in node) {
    node.children.forEach(displayMath)
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
  ;(data.fromMarkdownExtensions ??= []).push(fromMarkdown)
  return (tree, file) => {
    const sources = new Map<number, string>()
    file.data.chatMathSources = sources
    // Link labels remain ordinary Markdown even when the label contains delimiters.
    function literalLinks(node: Nodes, inLink = false): void {
      if (node.type === 'inlineMath' && node.position?.start.offset !== undefined) {
        sources.set(node.position.start.offset, String(node.data?.mathSource ?? node.value))
      }
      if ('children' in node) {
        for (const child of node.children) {
          if ((inLink || node.type === 'link') && child.type === 'inlineMath') {
            child.data = {
              hName: 'span',
              hChildren: [{ type: 'text', value: String(child.data?.mathSource ?? child.value) }]
            }
          }
          literalLinks(child, inLink || node.type === 'link')
        }
      }
    }
    literalLinks(tree)
    displayMath(tree)
  }
}
