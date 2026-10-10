import type { editor, languages } from 'monaco-editor'
import type { IOnigLib } from 'vscode-textmate'
import { yieldToEventLoop } from '../../../../shared/event-loop-yield'

export type JsxCommentContext = 'jsx' | 'script' | 'unknown'
type ProviderLoader = () => Promise<languages.TokensProvider>

let providerPromise: Promise<languages.TokensProvider> | undefined
const contextCaches = new WeakMap<
  editor.ITextModel,
  {
    version: number
    states: languages.IState[]
    contexts: JsxCommentContext[]
    unknownFrom: number | null
  }
>()

function scopeContext(scopes: readonly string[]): string {
  if (scopes.some((scope) => scope.startsWith('comment.block.'))) {
    return 'unknown'
  }
  const context = scopes.findLast(
    (scope) =>
      scope.startsWith('meta.jsx.children.') ||
      scope.startsWith('meta.tag.attributes.') ||
      scope.startsWith('meta.embedded.expression.')
  )
  return context?.startsWith('meta.jsx.children.') ? 'jsx' : 'script'
}

export async function loadJsxCommentTokensProvider(
  loadOniguruma?: () => Promise<IOnigLib>
): Promise<languages.TokensProvider> {
  const [source, { parseRawGrammar }, { createTextMateTokensProvider }] = await Promise.all([
    import('@/lib/monaco-languages/textmate-grammars/typescript-react.tmLanguage.json?raw'),
    import('vscode-textmate'),
    import('@/lib/monaco-languages/textmate-token-provider')
  ])
  const grammar = parseRawGrammar(source.default, 'tsx.json')
  return createTextMateTokensProvider({
    scopeName: grammar.scopeName,
    loadGrammar: async (scope) => (scope === grammar.scopeName ? grammar : null),
    mapTokenScopes: scopeContext,
    loadOniguruma
  })
}

function loadProvider(): Promise<languages.TokensProvider> {
  providerPromise ??= loadJsxCommentTokensProvider().catch((error: unknown) => {
    providerPromise = undefined
    throw error
  })
  return providerPromise
}

export async function getJsxCommentContexts(
  model: editor.ITextModel,
  lineNumbers: readonly number[],
  options: { isCurrent?: () => boolean; loadProvider?: ProviderLoader } = {}
): Promise<JsxCommentContext[] | null> {
  if (model.isDisposed()) {
    return null
  }
  const version = model.getVersionId()
  const isCurrent = () =>
    !model.isDisposed() && model.getVersionId() === version && (options.isCurrent?.() ?? true)
  const provider = await (options.loadProvider ?? loadProvider)()
  if (!isCurrent()) {
    return null
  }
  let cache = contextCaches.get(model)
  if (!cache || cache.version !== version) {
    cache = { version, contexts: [], states: [provider.getInitialState()], unknownFrom: null }
    contextCaches.set(model, cache)
  }
  const targetLine = Math.min(
    model.getLineCount(),
    lineNumbers.reduce((highest, line) => Math.max(highest, line), 0)
  )
  let started = performance.now()
  while (cache.contexts.length < targetLine && cache.unknownFrom === null) {
    if (!isCurrent()) {
      return null
    }
    const lineNumber = cache.contexts.length + 1
    const line = model.getLineContent(lineNumber)
    if (line.length >= 2_048) {
      cache.unknownFrom = lineNumber
      break
    }
    const result = provider.tokenize(line, cache.states[lineNumber - 1])
    const context = result.tokens[0]?.scopes
    cache.contexts.push(context === 'jsx' || context === 'unknown' ? context : 'script')
    cache.states.push(result.endState)
    if (cache.contexts.length < targetLine && performance.now() - started >= 2) {
      await yieldToEventLoop()
      started = performance.now()
    }
  }
  return isCurrent() ? lineNumbers.map((line) => cache.contexts[line - 1] ?? 'unknown') : null
}
