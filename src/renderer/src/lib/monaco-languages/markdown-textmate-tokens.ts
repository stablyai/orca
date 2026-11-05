import type * as Monaco from 'monaco-editor'
import type { IToken } from 'shiki/textmate'
import type { BundledLanguageInfo } from 'shiki/types'
import { useCodeEditorThemeStore } from '@/store/code-editor-theme'
import type { PluginMonacoTheme } from '../plugin-monaco-theme'
import { MARKDOWN_TOKEN_PREFIX, monacoMarkdownRules } from '../plugin-monaco-token-rules'
import { COLD_GRAMMAR_LINE_ATTEMPTS } from '../syntax-highlighting/textmate-core'
import { createTokensProvider, loadEditorCore } from './textmate-token-provider'

type MonacoModule = {
  editor: Pick<typeof Monaco.editor, 'defineTheme'>
  languages: Pick<typeof Monaco.languages, 'setTokensProvider'>
}

const MARKDOWN_LANGUAGE_ID = 'markdown'
const MARKDOWN_SCOPE_NAME = 'text.html.markdown'
// The grammar's catch-all fence rule; a specific fence rule takes over once its grammar loads.
const UNKNOWN_FENCE_LANGUAGE_SCOPE = 'fenced_code.block.language'
// The catch-all rule captures the whole info string, e.g. `ts title="a.ts"`.
const FENCE_INFO_SEPARATOR = /[\s{,:?]/

type ThemeRule = Monaco.editor.ITokenThemeRule

function markdownSelectors(rules: readonly ThemeRule[]): ReadonlySet<string> {
  return new Set(
    rules.flatMap(({ token }) =>
      token.startsWith(MARKDOWN_TOKEN_PREFIX) ? [token.slice(MARKDOWN_TOKEN_PREFIX.length)] : []
    )
  )
}

/** Why read at tokenize time: Monaco re-tokenizes on every theme change, so tokens settle the same
 *  whether the tokenizer or the theme loaded first. */
function createActiveSelectors(stock: ReadonlySet<string>): () => ReadonlySet<string> {
  let lastTheme: PluginMonacoTheme | null = null
  let selectors = stock
  return () => {
    const { monaco } = useCodeEditorThemeStore.getState()
    if (monaco !== lastTheme) {
      lastTheme = monaco
      selectors = monaco ? markdownSelectors(monaco.data.rules) : stock
    }
    return selectors
  }
}

function hasMatchingSelector(selectors: ReadonlySet<string>, scope: string): boolean {
  for (let end = scope.length; end > 0; end = scope.lastIndexOf('.', end - 1)) {
    if (selectors.has(scope.slice(0, end))) {
      return true
    }
  }
  return false
}

/** Monaco takes one scope per token, so pick the innermost one a theme rule styles, as VS Code's cascade would. */
function createScopeMapper(
  activeSelectors: () => ReadonlySet<string>
): (scopes: readonly string[]) => string {
  return (scopes) => {
    const selectors = activeSelectors()
    for (let index = scopes.length - 1; index >= 0; index -= 1) {
      if (hasMatchingSelector(selectors, scopes[index])) {
        return `${MARKDOWN_TOKEN_PREFIX}${scopes[index]}`
      }
    }
    return MARKDOWN_TOKEN_PREFIX + MARKDOWN_SCOPE_NAME
  }
}

function fenceLanguagesByLabel(
  bundledLanguagesInfo: readonly BundledLanguageInfo[],
  embeddedLanguageIds: readonly string[]
): Map<string, BundledLanguageInfo> {
  const embedded = new Set(embeddedLanguageIds)
  const byLabel = new Map<string, BundledLanguageInfo>()
  for (const info of bundledLanguagesInfo) {
    if (embedded.has(info.id)) {
      for (const label of [info.id, ...(info.aliases ?? [])]) {
        byLabel.set(label, info)
      }
    }
  }
  return byLabel
}

/** VS Code's markdown grammar with Dark+/Light+ colors; fence grammars load on first sight. */
export async function createMarkdownTokensProvider(
  monaco: MonacoModule
): Promise<Monaco.languages.TokensProvider> {
  const [editorCore, { default: markdownGrammars }, { bundledLanguagesInfo }] = await Promise.all([
    loadEditorCore(),
    import('shiki/langs/markdown.mjs'),
    import('shiki/langs')
  ])
  await editorCore.core.loadLanguage(...markdownGrammars)

  const darkRules = monacoMarkdownRules('dark', [], (value) => value)
  const lightRules = monacoMarkdownRules('light', [], (value) => value)
  // Why: Orca's editors all use the built-in theme names; redefining them keeps every setTheme caller unchanged.
  monaco.editor.defineTheme('vs-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: darkRules,
    colors: {}
  })
  monaco.editor.defineTheme('vs', { base: 'vs', inherit: true, rules: lightRules, colors: {} })
  const mapScopes = createScopeMapper(
    createActiveSelectors(markdownSelectors([...darkRules, ...lightRules]))
  )

  const fenceLanguages = fenceLanguagesByLabel(
    bundledLanguagesInfo,
    markdownGrammars[0]?.embeddedLangsLazy ?? []
  )
  const requestedFenceLanguages = new Set<string>()
  let refreshQueued = false

  function refreshProvider(): void {
    if (refreshQueued) {
      return
    }
    refreshQueued = true
    queueMicrotask(() => {
      refreshQueued = false
      // Why: loading a grammar rebuilds markdown's grammar; replacing the provider retokenizes from its fresh start state.
      monaco.languages.setTokensProvider(MARKDOWN_LANGUAGE_ID, buildProvider())
    })
  }

  function loadFenceLanguage(label: string): void {
    const info = fenceLanguages.get(label.trim().split(FENCE_INFO_SEPARATOR)[0].toLowerCase())
    if (!info || requestedFenceLanguages.has(info.id)) {
      return
    }
    requestedFenceLanguages.add(info.id)
    void info
      .import()
      .then(({ default: grammars }) => editorCore.core.loadLanguage(...grammars))
      .then(refreshProvider)
      .catch((error: unknown) => {
        console.warn(
          `[markdown] failed to load the ${info.id} fence grammar; it stays plain`,
          error
        )
      })
  }

  function observeFenceLabels(line: string, tokens: readonly IToken[]): void {
    for (const token of tokens) {
      if (token.scopes.at(-1) === UNKNOWN_FENCE_LANGUAGE_SCOPE) {
        loadFenceLanguage(line.slice(token.startIndex, token.endIndex))
      }
    }
  }

  function buildProvider(): Monaco.languages.TokensProvider {
    return createTokensProvider(
      editorCore,
      editorCore.core.getLanguage(MARKDOWN_LANGUAGE_ID),
      MARKDOWN_SCOPE_NAME,
      mapScopes,
      observeFenceLabels,
      // Why: each fence grammar compiles on its first block, long after the markdown root has warmed.
      COLD_GRAMMAR_LINE_ATTEMPTS
    )
  }

  return buildProvider()
}
