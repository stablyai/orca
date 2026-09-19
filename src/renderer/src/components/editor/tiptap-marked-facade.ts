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

const ESCAPED_CHARACTER_TOKEN = 'richMarkdownEscapedCharacter'

function preserveEscapedCharacters(tokens: Token[]): Token[] {
  return tokens.map((token) => {
    if (token.type === 'escape') {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this token shape is the Markdown manager's custom inline token contract.
      return { type: ESCAPED_CHARACTER_TOKEN, raw: token.raw, character: token.text } as Token
    }
    if ('tokens' in token && Array.isArray(token.tokens)) {
      token.tokens = preserveEscapedCharacters(token.tokens)
    }
    return token
  })
}

export function createTiptapMarkedFacade(): typeof marked {
  const registry = new Marked()
  registry.use({
    tokenizer: {
      link(src) {
        const token = Tokenizer.prototype.link.call(this, src)
        const label = token ? this.rules.inline.link.exec(src)?.[1] : undefined
        if (token?.type === 'image' && label !== undefined) {
          token.text = label.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~])/g, '$1')
        }
        if (token?.type === 'link' && label && /\\(?:\[|\])/.test(label)) {
          // Preserve label escapes before nested inline parsing can reinterpret them as links.
          const wasInLink = this.lexer.state.inLink
          this.lexer.state.inLink = true
          try {
            token.tokens = this.lexer.inlineTokens(label)
          } finally {
            this.lexer.state.inLink = wasInLink
          }
        }
        return token
      }
    }
  })

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

    inlineTokens(src: string, tokens: Token[] = []): Token[] {
      return preserveEscapedCharacters(super.inlineTokens(src, tokens))
    }

    // Why: Tiptap's markdown parser has no case for marked's `escape` token, so
    // `\$`, `\*`, `\_`, `\[` would be deleted from the document on load.
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
