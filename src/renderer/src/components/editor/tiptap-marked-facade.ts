import { getMarkdownTokenizerStartMarker } from './markdown-tokenizer-start'
import {
  Hooks,
  Lexer,
  Marked,
  Parser,
  Renderer,
  TextRenderer,
  Tokenizer,
  getDefaults,
  type MarkedOptions,
  type Token,
  type Tokens,
  type TokensList,
  marked
} from 'marked'
import { ORDERED_LIST_MARKER_PATTERN } from '@tiptap/extension-list'

// Same item start Tiptap's ordered list accepts, so every list it built can be re-read here.
const TIPTAP_LIST_ITEM = new RegExp(`^(\\s*(?:${ORDERED_LIST_MARKER_PATTERN})[.)])(\\s+)`)

function expandColumns(text: string, startColumn = 0): number {
  let column = startColumn
  for (const char of text) {
    column = char === '\t' ? column + 4 - (column % 4) : column + 1
  }
  return column
}

// Marked's rule: tabs expand to 4-column stops; a gap wider than 4 means marker + 1.
function getItemContentIndent(item: RegExpExecArray): number {
  const markerEnd = expandColumns(item[1])
  const contentStart = expandColumns(item[2], markerEnd)
  return contentStart - markerEnd > 4 ? markerEnd + 1 : contentStart
}

// Like Marked's list, end at a quote line shallower than the current item's content;
// Tiptap's tokenizer would absorb the outer quote's lines and nest them in the item.
function sliceBeforeOuterQuote(source: string): string {
  const lines = source.split('\n')
  let contentIndent = 0
  let outerQuoteLine = /^>/
  for (const [index, line] of lines.entries()) {
    const item = TIPTAP_LIST_ITEM.exec(line)
    const lineIndent = expandColumns(/^\s*/.exec(line)?.[0] ?? '')
    if (item && (index === 0 || lineIndent < contentIndent)) {
      contentIndent = getItemContentIndent(item)
      outerQuoteLine = new RegExp(`^ {0,${Math.max(0, Math.min(3, contentIndent - 1))}}>`)
    } else if (index > 0 && outerQuoteLine.test(line)) {
      return lines.slice(0, index).join('\n')
    }
  }
  return source
}

function isListToken(token: Tokens.Generic | undefined): token is Tokens.List {
  return token?.type === 'list' && Array.isArray(token.items)
}

class BlockquoteListTokenizer extends Tokenizer {
  // Why: Marked's blockquote() lazy continuation calls `this.list(newText)!` (still so in v18),
  // skipping the registered tokenizer that also reads `1.` + no-break space, then reads `.raw`.
  list(source: string): Tokens.List | undefined {
    const token = super.list(source)
    if (token || !TIPTAP_LIST_ITEM.test(source)) {
      return token
    }
    const listSource = sliceBeforeOuterQuote(source)
    for (const tokenize of this.options.extensions?.block ?? []) {
      const extended = tokenize.call({ lexer: this.lexer }, listSource, [])
      if (isListToken(extended)) {
        return extended
      }
    }
    return undefined
  }
}

export function createTiptapMarkedFacade(): typeof marked {
  const registry = new Marked()

  // Why: Tiptap 3.22.5 registers on the injected instance but parses with
  // `new instance.Lexer()`, so the constructor must retain the private registry.
  class RegistryLexer extends Lexer {
    private readonly registeredExtensions = this.options.extensions
    blockTokens(source: string, tokens?: TokensList, lastParagraphClipped?: boolean): TokensList
    blockTokens(source: string, tokens?: Token[], lastParagraphClipped?: boolean): Token[]
    blockTokens(source: string, tokens?: Token[], lastParagraphClipped?: boolean): Token[] {
      const previousExtensions = this.options.extensions
      const extensions = this.registeredExtensions
      if (!extensions?.startBlock) {
        return super.blockTokens(source, tokens, lastParagraphClipped)
      }
      const startBlock = extensions.startBlock.filter((start) => {
        const marker = getMarkdownTokenizerStartMarker(start)
        return !marker || source.includes(marker)
      })
      this.options.extensions = { ...extensions, startBlock }
      try {
        return super.blockTokens(source, tokens, lastParagraphClipped)
      } finally {
        this.options.extensions = previousExtensions
      }
    }

    constructor(options?: MarkedOptions) {
      super({
        ...registry.defaults,
        ...options,
        tokenizer:
          options?.tokenizer ?? registry.defaults.tokenizer ?? new BlockquoteListTokenizer(),
        extensions: registry.defaults.extensions
      })
    }
  }

  const parser = (tokens: Token[], options?: MarkedOptions) => registry.parser(tokens, options)
  const lexer = (src: string, options?: MarkedOptions): TokensList =>
    new RegistryLexer(options).lex(src)
  const facade = new Proxy(marked, {
    apply: (_target, _thisArg, args: [src: string, options?: MarkedOptions | null]) =>
      registry.parse(...args),
    get: (target, property, receiver) => {
      switch (property) {
        case 'defaults':
          return registry.defaults
        case 'getDefaults':
          return getDefaults
        case 'Lexer':
          return RegistryLexer
        case 'Parser':
          return Parser
        case 'Renderer':
          return Renderer
        case 'TextRenderer':
          return TextRenderer
        case 'Tokenizer':
          return Tokenizer
        case 'Hooks':
          return Hooks
        case 'parse':
          return facade
        case 'parseInline':
          return registry.parseInline
        case 'parser':
          return parser
        case 'lexer':
          return lexer
        case 'walkTokens':
          return registry.walkTokens.bind(registry)
        case 'use':
          return (...extensions: Parameters<typeof registry.use>) => {
            registry.use(...extensions)
            return facade
          }
        case 'setOptions':
        case 'options':
          return (options: MarkedOptions) => {
            registry.setOptions(options)
            return facade
          }
        default:
          // oxlint-disable-next-line anti-slop/no-reflect-get -- Proxy `get` trap: only Reflect.get forwards a raw string|symbol key with the proxy receiver.
          return Reflect.get(target, property, receiver)
      }
    }
  }) satisfies typeof marked

  return facade
}
