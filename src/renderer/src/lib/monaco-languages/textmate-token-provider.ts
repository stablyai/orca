import type * as Monaco from 'monaco-editor'
import { INITIAL, Registry } from 'vscode-textmate'
import type { IGrammar, IOnigLib, IRawGrammar, StateStack } from 'vscode-textmate'
import onigurumaWasmUrl from 'vscode-oniguruma/release/onig.wasm?url'

type TextMateTokensProvider = Monaco.languages.TokensProvider
type TextMateEncodedTokensProvider = Monaco.languages.EncodedTokensProvider

export type TextMateGrammarLoader = (scopeName: string) => Promise<IRawGrammar | null | undefined>

export type TextMateTokensProviderOptions = {
  scopeName: string
  loadGrammar: TextMateGrammarLoader
  loadOniguruma?: () => Promise<IOnigLib>
}

export type TextMateEncodedTokensProviderOptions = TextMateTokensProviderOptions & {
  initialLanguage: number
  embeddedLanguages: Record<string, number>
}

let browserOnigurumaPromise: Promise<IOnigLib> | undefined

async function loadBrowserOniguruma(): Promise<IOnigLib> {
  browserOnigurumaPromise ??= (async () => {
    const oniguruma = await import('vscode-oniguruma')
    const response = await fetch(onigurumaWasmUrl)
    if (!response.ok) {
      throw new Error(`Failed to load TextMate regex engine from ${onigurumaWasmUrl}`)
    }

    await oniguruma.loadWASM(response)
    return {
      createOnigScanner: oniguruma.createOnigScanner,
      createOnigString: oniguruma.createOnigString
    }
  })()

  return browserOnigurumaPromise
}

class TextMateTokenizerState implements Monaco.languages.IState {
  constructor(readonly ruleStack: StateStack) {}

  clone(): TextMateTokenizerState {
    return new TextMateTokenizerState(this.ruleStack.clone())
  }

  equals(other: Monaco.languages.IState): boolean {
    return other instanceof TextMateTokenizerState && this.ruleStack.equals(other.ruleStack)
  }
}

function createTokensProvider(
  grammar: IGrammar,
  fallbackScopeName: string
): TextMateTokensProvider {
  return {
    getInitialState() {
      return new TextMateTokenizerState(INITIAL)
    },
    tokenize(line, state) {
      const textMateState =
        state instanceof TextMateTokenizerState ? state : new TextMateTokenizerState(INITIAL)
      const result = grammar.tokenizeLine(line, textMateState.ruleStack)

      return {
        endState: new TextMateTokenizerState(result.ruleStack),
        tokens: result.tokens.map((token) => ({
          startIndex: token.startIndex,
          // Why: Monaco themes match a single token scope; TextMate returns a
          // scope stack, and the final entry is the most specific reusable one.
          scopes: token.scopes.at(-1) ?? fallbackScopeName
        }))
      }
    }
  }
}

function createEncodedTokensProvider(grammar: IGrammar): TextMateEncodedTokensProvider {
  return {
    getInitialState() {
      return new TextMateTokenizerState(INITIAL)
    },
    tokenizeEncoded(line, state) {
      const textMateState =
        state instanceof TextMateTokenizerState ? state : new TextMateTokenizerState(INITIAL)
      const result = grammar.tokenizeLine2(line, textMateState.ruleStack)
      return {
        endState: new TextMateTokenizerState(result.ruleStack),
        tokens: result.tokens
      }
    }
  }
}

async function requireGrammar(
  scopeName: string,
  load: () => Promise<IGrammar | null>
): Promise<IGrammar> {
  let grammar: IGrammar | null
  try {
    grammar = await load()
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes(`No grammar provided for <${scopeName}>`)
    ) {
      throw new Error(`No TextMate grammar registered for scope ${scopeName}`)
    }
    throw error
  }
  if (!grammar) {
    throw new Error(`No TextMate grammar registered for scope ${scopeName}`)
  }
  return grammar
}

function createRegistry(options: TextMateTokensProviderOptions): Registry {
  return new Registry({
    onigLib: (options.loadOniguruma ?? loadBrowserOniguruma)(),
    loadGrammar: options.loadGrammar
  })
}

export async function createTextMateTokensProvider(
  options: TextMateTokensProviderOptions
): Promise<TextMateTokensProvider> {
  const registry = createRegistry(options)
  const grammar = await requireGrammar(options.scopeName, () =>
    registry.loadGrammar(options.scopeName)
  )

  return createTokensProvider(grammar, options.scopeName)
}

export async function createTextMateEncodedTokensProvider(
  options: TextMateEncodedTokensProviderOptions
): Promise<TextMateEncodedTokensProvider> {
  const registry = createRegistry(options)
  const grammar = await requireGrammar(options.scopeName, () =>
    registry.loadGrammarWithEmbeddedLanguages(
      options.scopeName,
      options.initialLanguage,
      options.embeddedLanguages
    )
  )

  return createEncodedTokensProvider(grammar)
}
