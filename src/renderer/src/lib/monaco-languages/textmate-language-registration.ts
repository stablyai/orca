import type * as Monaco from 'monaco-editor'
import type {
  createTextMateTokensProvider as createTextMateTokensProviderType,
  TextMateGrammarLoader
} from './textmate-token-provider'

type MonacoModule = typeof Monaco
type TextMateTokensProvider = Monaco.languages.TokensProvider
type TextMateTokenProviderModule = {
  createTextMateTokensProvider: typeof createTextMateTokensProviderType
}

export type TextMateLanguageRegistration = {
  language: Monaco.languages.ILanguageExtensionPoint
  configuration?: Monaco.languages.LanguageConfiguration
  scopeName: string
  loadGrammar: TextMateGrammarLoader
  loadProviderModule?: () => Promise<TextMateTokenProviderModule>
  // Why: Monaco's basic languages (e.g. Ruby) are pre-registered with a lazy Monarch factory.
  replaceExistingTokenizer?: boolean
}

function loadDefaultProviderModule(): Promise<TextMateTokenProviderModule> {
  return import('./textmate-token-provider')
}

export function registerTextMateLanguage(
  monaco: Pick<MonacoModule, 'languages'>,
  registration: TextMateLanguageRegistration
): void {
  const languageAlreadyRegistered = monaco.languages
    .getLanguages()
    .some((language) => language.id === registration.language.id)
  if (languageAlreadyRegistered && !registration.replaceExistingTokenizer) {
    return
  }

  if (!languageAlreadyRegistered) {
    monaco.languages.register(registration.language)
    if (registration.configuration) {
      monaco.languages.setLanguageConfiguration(
        registration.language.id,
        registration.configuration
      )
    }
  }

  // Why: TokenizationRegistry.registerFactory disposes the prior factory (and any tokenizer it
  // installed) and its late resolution is dropped, so the last registered factory wins.

  let tokensProviderPromise: Promise<TextMateTokensProvider> | undefined
  monaco.languages.registerTokensProviderFactory(registration.language.id, {
    create: () => {
      // Why: plain Monaco tokenization requests basic language features; onLanguage
      // only fires for rich features, so it never loads for a read-only Nim editor.
      tokensProviderPromise ??= (
        registration.loadProviderModule ?? loadDefaultProviderModule
      )().then(({ createTextMateTokensProvider }) =>
        createTextMateTokensProvider({
          scopeName: registration.scopeName,
          loadGrammar: registration.loadGrammar
        })
      )
      return tokensProviderPromise
    }
  })
}
