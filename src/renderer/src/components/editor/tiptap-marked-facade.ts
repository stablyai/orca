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
  type TokensList,
  marked
} from 'marked'

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
