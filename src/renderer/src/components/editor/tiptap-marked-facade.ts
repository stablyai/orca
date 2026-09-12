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

/** Rewrites escape tokens in place (marked fills caller-owned arrays for table cells). */
function preserveEscapedCharacters(tokens: Token[]): Token[] {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token.type === 'escape') {
      tokens[index] = { type: 'text', raw: token.raw, text: token.text, escaped: false }
    }
  }
  return tokens
}

export function createTiptapMarkedFacade(): typeof marked {
  const registry = new Marked()

  // Why: Tiptap 3.22.5 registers on the injected instance but parses with
  // `new instance.Lexer()`, so the constructor must retain the private registry.
  class RegistryLexer extends Lexer {
    constructor(options?: MarkedOptions) {
      super({
        ...registry.defaults,
        ...options,
        extensions: registry.defaults.extensions
      })
    }

    // Why: Tiptap's markdown parser has no case for marked's `escape` token, so
    // `\$`, `\*`, `\_`, `\[` would be deleted from the document on load.
    inlineTokens(src: string, tokens: Token[] = []): Token[] {
      return preserveEscapedCharacters(super.inlineTokens(src, tokens))
    }
  }

  const parser = (tokens: Token[], options?: MarkedOptions) => registry.parser(tokens, options)
  const lexer = (src: string, options?: MarkedOptions): TokensList =>
    new RegistryLexer(options).lex(src)
  const facade = new Proxy(marked, {
    apply: (_target, _thisArg, args) => Reflect.apply(registry.parse, registry, args),
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
          return Reflect.get(target, property, receiver)
      }
    }
  }) satisfies typeof marked

  return facade
}
