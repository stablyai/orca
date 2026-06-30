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
export type TextMateScopeNameResolver = string | (() => Promise<string>)
export type TextMateGrammarInjectionsProvider = (scopeName: string) => string[] | undefined

export type TextMateLanguageRegistration = {
  language: Monaco.languages.ILanguageExtensionPoint
  configuration?: Monaco.languages.LanguageConfiguration
  scopeName: TextMateScopeNameResolver
  loadGrammar: TextMateGrammarLoader
  getInjections?: TextMateGrammarInjectionsProvider
  loadProviderModule?: () => Promise<TextMateTokenProviderModule>
}

function loadDefaultProviderModule(): Promise<TextMateTokenProviderModule> {
  return import('./textmate-token-provider')
}

export function registerTextMateTokensProvider(
  monaco: MonacoModule,
  languageId: string,
  registration: Pick<
    TextMateLanguageRegistration,
    'scopeName' | 'loadGrammar' | 'getInjections' | 'loadProviderModule'
  >
): void {
  let tokensProviderPromise: Promise<TextMateTokensProvider> | undefined
  monaco.languages.registerTokensProviderFactory(languageId, {
    create: () => {
      // Why: plain Monaco tokenization requests basic language features; onLanguage
      // only fires for rich features, so it never loads for read-only editors.
      tokensProviderPromise ??= (
        registration.loadProviderModule ?? loadDefaultProviderModule
      )().then(async ({ createTextMateTokensProvider }) => {
        const scopeName =
          typeof registration.scopeName === 'function'
            ? await registration.scopeName()
            : registration.scopeName

        return createTextMateTokensProvider({
          getInjections: registration.getInjections,
          scopeName,
          loadGrammar: registration.loadGrammar
        })
      })
      return tokensProviderPromise
    }
  })
}

export function registerTextMateLanguage(
  monaco: MonacoModule,
  registration: TextMateLanguageRegistration
): void {
  const languageAlreadyRegistered = monaco.languages
    .getLanguages()
    .some((language) => language.id === registration.language.id)
  if (languageAlreadyRegistered) {
    return
  }

  monaco.languages.register(registration.language)
  if (registration.configuration) {
    monaco.languages.setLanguageConfiguration(registration.language.id, registration.configuration)
  }

  registerTextMateTokensProvider(monaco, registration.language.id, registration)
}
