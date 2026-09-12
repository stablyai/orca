import type * as Monaco from 'monaco-editor'
import type { CustomLanguageSnapshot } from '../../../../shared/custom-languages'
import { registerTextMateLanguage } from './textmate-language-registration'

export function registerCustomLanguages(
  monaco: typeof Monaco,
  snapshot: CustomLanguageSnapshot,
  reportError: (message: string) => void
): void {
  for (const message of snapshot.diagnostics) {
    reportError(message)
  }
  for (const { scopeName, configuration, ...language } of snapshot.languages) {
    registerTextMateLanguage(monaco, {
      language,
      scopeName,
      configuration,
      loadGrammar: async (scope) => {
        if (!Object.hasOwn(snapshot.grammars, scope)) {
          throw new Error(
            `Missing TextMate grammar ${scope}; add its extension or grammar file to languages.json`
          )
        }
        return snapshot.grammars[scope]
      },
      onError: (error) => reportError(`${language.id}: ${String(error)}`)
    })
  }
}
