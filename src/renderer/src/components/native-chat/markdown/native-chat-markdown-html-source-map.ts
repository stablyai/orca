import type { Root } from 'mdast'
import type { Data, Processor } from 'unified'
import type { RemendCopyPiece } from 'remend'
import type { VFile } from 'vfile'
import { copyMappedMarkdown, type MappedMarkdown } from './native-chat-markdown-source-map'
import type { HtmlRewriteObserver } from '../../sidebar/comment-markdown-unknown-html-as-text'

declare module 'mdast' {
  // oxlint-disable-next-line typescript/consistent-type-definitions -- Parsed node metadata uses declaration merging.
  interface HtmlData {
    nativeChatHtmlTokenOrigins?: RemendCopyPiece[]
  }
}

type ParserExtensions = NonNullable<Data['fromMarkdownExtensions']>
type ParserExtension = Exclude<ParserExtensions[number], unknown[]>
type ParserHandle = NonNullable<NonNullable<ParserExtension['exit']>[string]>
type HtmlToken = Parameters<ParserHandle>[0]
type HtmlTokenContext = ThisParameterType<ParserHandle>

function isHtmlTrace(value: unknown): value is RemendCopyPiece[] {
  return (
    Array.isArray(value) &&
    value.every(
      (piece) =>
        typeof piece === 'string' ||
        (Array.isArray(piece) &&
          piece.length === 2 &&
          typeof piece[0] === 'number' &&
          typeof piece[1] === 'number')
    )
  )
}

/** Keep node-relative spans on pristine trees so block reuse never requires another parse. */
export function remarkNativeChatHtmlTokenOrigins(this: Processor): void {
  let input = ''
  const parse = this.parser
  if (!parse) {
    throw new Error('HTML provenance must follow the Markdown parser')
  }
  this.parser = (document, file) => {
    input = document
    return parse(document, file)
  }
  const piecesByNode = new WeakMap<object, RemendCopyPiece[]>()
  function capture(context: HtmlTokenContext, token: HtmlToken): void {
    const html = context.stack.findLast((node) => node.type === 'html')
    const base = html?.position?.start.offset
    if (!html || base === undefined) {
      return
    }
    const pieces = piecesByNode.get(html) ?? []
    piecesByNode.set(html, pieces)
    html.data = { ...html.data, nativeChatHtmlTokenOrigins: pieces }
    const serialized = context.sliceSerialize(token)
    const start = token.start.offset
    const end = token.type === 'lineEnding' ? start + serialized.length : token.end.offset
    const authored = input.slice(start, end)
    const normalized = authored.replace(/\0/g, '\uFFFD')
    const virtual = serialized.length - normalized.length
    if (
      virtual < 0 ||
      virtual > 3 ||
      serialized !== ' '.repeat(virtual) + normalized ||
      (virtual > 0 && input[start - 1] !== '\t')
    ) {
      throw new Error('Unsupported HTML token serialization in source provenance')
    }
    if (virtual) {
      pieces.push(' '.repeat(virtual))
    }
    let copied = start
    for (let index = start; index < end; index++) {
      if (input[index] !== '\0') {
        continue
      }
      pieces.push([copied - base, index - base], '\uFFFD')
      copied = index + 1
    }
    pieces.push([copied - base, end - base])
  }
  function exitData(this: HtmlTokenContext, token: HtmlToken): void {
    capture(this, token)
    // Preserve the pinned parser's onexitdata operation while observing its source span.
    const tail = this.stack.pop()
    if (!tail || !('value' in tail) || typeof tail.value !== 'string' || !tail.position) {
      throw new Error('HTML parser data stack lost its text node')
    }
    tail.value += this.sliceSerialize(token)
    tail.position.end = { line: token.end.line, column: token.end.column, offset: token.end.offset }
  }
  const extensions = (this.data().fromMarkdownExtensions ??= [])
  extensions.push({
    enter: {
      lineEnding(this: HtmlTokenContext, token: HtmlToken) {
        capture(this, token)
      }
    },
    exit: { htmlFlowData: exitData, htmlTextData: exitData }
  })
}

export class NativeChatHtmlSourceMaps {
  readonly values = new WeakMap<object, MappedMarkdown>()
  constructor(private readonly source: MappedMarkdown) {}

  readonly rewrite: HtmlRewriteObserver = (node, pieces) => {
    const source = this.values.get(node)
    if (!source) {
      throw new Error('Missing authored HTML value map')
    }
    this.values.set(node, copyMappedMarkdown(source, pieces))
  }

  readonly bind =
    () =>
    (tree: Root, file: VFile): void => {
      file.data.markdownHtmlRewrite = this.rewrite
      const visit = (node: Root | Root['children'][number]): void => {
        if (node.type === 'html') {
          const pieces = node.data?.nativeChatHtmlTokenOrigins
          const start = node.position?.start.offset
          if (!isHtmlTrace(pieces) || start === undefined) {
            throw new Error('Missing parsed HTML token provenance')
          }
          const absolute = pieces.map((piece): RemendCopyPiece =>
            typeof piece === 'string' ? piece : [piece[0] + start, piece[1] + start]
          )
          const value = copyMappedMarkdown(this.source, absolute)
          if (value.text !== node.value) {
            throw new Error('HTML source provenance changed its value')
          }
          this.values.set(node, value)
        }
        if ('children' in node) {
          for (const child of node.children) {
            visit(child)
          }
        }
      }
      visit(tree)
    }
}
