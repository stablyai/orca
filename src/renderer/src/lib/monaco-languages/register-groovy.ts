import type * as Monaco from 'monaco-editor'
import type { LanguageRegistration } from 'shiki/core'
import { registerTextMateLanguage } from './textmate-language-registration'

function mapGroovyTokenScope(scope: string): string | undefined {
  if (scope.startsWith('storage.type.annotation.')) {
    return 'annotation.groovy'
  }
  if (scope.startsWith('constant.numeric.')) {
    return 'number.groovy'
  }
  if (scope === 'storage.type.groovy' || scope.startsWith('entity.')) {
    return 'type.groovy'
  }
  if (scope.startsWith('storage.')) {
    return 'keyword.groovy'
  }
  // Symbolic operators stay plain text like VS Code; only as/in/instanceof read as keywords.
  if (
    scope.startsWith('keyword.operator.') &&
    !/^keyword\.operator\.(?:as|in|instanceof)\./.test(scope)
  ) {
    return undefined
  }
  return /^(?:comment|string|keyword|constant|variable|invalid)\./.test(scope) ? scope : undefined
}

// Why: stock Monaco themes style none of storage.*, and quote/comment punctuation must inherit its parent's color.
function mapGroovyTokenScopes(scopes: readonly string[]): string {
  // Embedded ${} code stays out of its enclosing string's color.
  for (let index = scopes.length - 1; index >= 0 && !scopes[index].startsWith('source.'); index--) {
    const mapped = mapGroovyTokenScope(scopes[index])
    if (mapped) {
      return mapped
    }
  }
  return 'source.groovy'
}

async function loadGroovyTextMateGrammar(): Promise<LanguageRegistration> {
  const { default: grammars } = await import('shiki/langs/groovy.mjs')
  return grammars[0]
}

export function registerGroovyLanguage(monaco: Pick<typeof Monaco, 'languages'>): void {
  registerTextMateLanguage(monaco, {
    language: {
      id: 'groovy',
      extensions: ['.groovy', '.gvy', '.gy', '.gsh', '.gradle', '.jenkinsfile'],
      filenames: ['Jenkinsfile'],
      aliases: ['Groovy', 'groovy']
    },
    configuration: {
      comments: { lineComment: '//', blockComment: ['/*', '*/'] },
      brackets: [
        ['{', '}'],
        ['[', ']'],
        ['(', ')']
      ],
      autoClosingPairs: [
        { open: '{', close: '}' },
        { open: '[', close: ']' },
        { open: '(', close: ')' },
        { open: '"', close: '"', notIn: ['string', 'comment'] },
        { open: "'", close: "'", notIn: ['string', 'comment'] }
      ]
    },
    loadGrammar: loadGroovyTextMateGrammar,
    mapTokenScopes: mapGroovyTokenScopes
  })
}
