import type * as Monaco from 'monaco-editor'
import type { LanguageRegistration } from 'shiki/core'
import { registerTextMateLanguage } from './textmate-language-registration'

// Why: stock Monaco themes style none of the grammar's storage/entity/argument scopes.
function mapCMakeTokenScopes(scopes: readonly string[]): string {
  const scope = scopes.at(-1) ?? 'source.cmake'
  if (scope.startsWith('constant.character.escape')) {
    return 'string.escape.cmake'
  }
  if (scope.startsWith('storage.')) {
    return 'variable.cmake'
  }
  if (scope.startsWith('entity.')) {
    return 'type.cmake'
  }
  if (scope.startsWith('argument.')) {
    return 'string.cmake'
  }
  return scope
}

async function loadCMakeTextMateGrammar(): Promise<LanguageRegistration> {
  const { default: grammars } = await import('shiki/langs/cmake.mjs')
  return grammars[0]
}

export function registerCMakeLanguage(monaco: Pick<typeof Monaco, 'languages'>): void {
  registerTextMateLanguage(monaco, {
    language: {
      id: 'cmake',
      filenames: ['CMakeLists.txt'],
      aliases: ['CMake', 'cmake']
    },
    configuration: {
      comments: { lineComment: '#', blockComment: ['#[[', ']]'] },
      brackets: [['(', ')']],
      autoClosingPairs: [
        { open: '(', close: ')' },
        { open: '"', close: '"', notIn: ['string', 'comment'] }
      ]
    },
    loadGrammar: loadCMakeTextMateGrammar,
    mapTokenScopes: mapCMakeTokenScopes
  })
}
