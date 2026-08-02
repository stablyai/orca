import type * as Monaco from 'monaco-editor'
import { INITIAL, Registry } from 'vscode-textmate'
import type { IGrammar, IOnigLib, IRawGrammar, StateStack } from 'vscode-textmate'
import onigurumaWasmUrl from 'vscode-oniguruma/release/onig.wasm?url'

type TextMateTokensProvider = Monaco.languages.TokensProvider

export type TextMateGrammarLoader = (scopeName: string) => Promise<IRawGrammar | null | undefined>

export type TextMateTokensProviderOptions = {
  scopeName: string
  loadGrammar: TextMateGrammarLoader
  loadOniguruma?: () => Promise<IOnigLib>
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

export async function createTextMateTokensProvider(
  options: TextMateTokensProviderOptions
): Promise<TextMateTokensProvider> {
  const registry = new Registry({
    onigLib: (options.loadOniguruma ?? loadBrowserOniguruma)(),
    loadGrammar: options.loadGrammar
  })
  let grammar: IGrammar | null
  try {
    grammar = await registry.loadGrammar(options.scopeName)
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes(`No grammar provided for <${options.scopeName}>`)
    ) {
      throw new Error(`No TextMate grammar registered for scope ${options.scopeName}`)
    }
    throw error
  }
  if (!grammar) {
    throw new Error(`No TextMate grammar registered for scope ${options.scopeName}`)
  }

  return createTokensProvider(grammar, options.scopeName)
}
