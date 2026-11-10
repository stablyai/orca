import type * as Monaco from 'monaco-editor'
import type { Grammar, LanguageRegistration } from 'shiki/core'
import type { IToken, StateStack } from 'shiki/textmate'
import {
  COLD_GRAMMAR_LINE_ATTEMPTS,
  createTextMateCore,
  tokenizeLineWithinLimits,
  type TextMateCore
} from '../syntax-highlighting/textmate-core'

type TextMateTokensProvider = Monaco.languages.TokensProvider

/** A vendored grammar, named by its Monaco language id. */
export type TextMateGrammarLoader = () => Promise<LanguageRegistration>

export type TextMateTokensProviderOptions = {
  loadGrammar: TextMateGrammarLoader
  mapTokenScopes?: (scopes: readonly string[]) => string
}

let editorCorePromise: Promise<TextMateCore> | undefined

// Why: chat's registry holds the catalogue's Nim and Typst under the same scope names as these vendored grammars.
export function loadEditorCore(): Promise<TextMateCore> {
  editorCorePromise ??= createTextMateCore([]).catch((error: unknown) => {
    editorCorePromise = undefined
    throw error
  })
  return editorCorePromise
}

class TextMateTokenizerState implements Monaco.languages.IState {
  /** `ruleStack` is null once a line was skipped; the lines after it stay plain. */
  constructor(readonly ruleStack: StateStack | null) {}

  clone(): TextMateTokenizerState {
    return new TextMateTokenizerState(this.ruleStack?.clone() ?? null)
  }

  equals(other: Monaco.languages.IState): boolean {
    if (!(other instanceof TextMateTokenizerState)) {
      return false
    }
    // Why: structural equality is what lets Monaco stop re-tokenizing once an edit's states converge.
    return this.ruleStack && other.ruleStack
      ? this.ruleStack.equals(other.ruleStack)
      : this.ruleStack === other.ruleStack
  }
}

export function createTokensProvider(
  { textmate }: TextMateCore,
  grammar: Grammar,
  fallbackScopeName: string,
  mapTokenScopes?: (scopes: readonly string[]) => string,
  onLineTokens?: (line: string, tokens: readonly IToken[]) => void,
  lineAttempts?: number
): TextMateTokensProvider {
  const plain = (state: TextMateTokenizerState): Monaco.languages.ILineTokens => ({
    endState: state,
    tokens: [{ startIndex: 0, scopes: fallbackScopeName }]
  })
  const skipped = new TextMateTokenizerState(null)
  let warm = false
  return {
    getInitialState() {
      return new TextMateTokenizerState(textmate.INITIAL)
    },
    tokenize(line, state) {
      const ruleStack = state instanceof TextMateTokenizerState ? state.ruleStack : textmate.INITIAL
      if (!ruleStack) {
        return plain(skipped)
      }
      const result = tokenizeLineWithinLimits(
        line,
        (text, timeLimitMs) => grammar.tokenizeLine(text, ruleStack, timeLimitMs),
        lineAttempts ?? (warm ? undefined : COLD_GRAMMAR_LINE_ATTEMPTS)
      )
      if (!result) {
        // Why: the line's end state is unknown, so continuing would color later lines from a guess.
        return plain(skipped)
      }
      warm = true
      onLineTokens?.(line, result.tokens)
      return {
        endState: new TextMateTokenizerState(result.ruleStack),
        tokens: result.tokens.map((token) => ({
          startIndex: token.startIndex,
          // Use final TextMate scope: Monaco accepts one scope, while TextMate’s final stack entry is most specific.
          scopes: mapTokenScopes?.(token.scopes) ?? token.scopes.at(-1) ?? fallbackScopeName
        }))
      }
    }
  }
}

export async function createTextMateTokensProvider(
  options: TextMateTokensProviderOptions
): Promise<TextMateTokensProvider> {
  const [editorCore, registration] = await Promise.all([loadEditorCore(), options.loadGrammar()])
  await editorCore.core.loadLanguage(registration)
  return createTokensProvider(
    editorCore,
    editorCore.core.getLanguage(registration.name),
    registration.scopeName,
    options.mapTokenScopes
  )
}
