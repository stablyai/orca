import type * as Monaco from 'monaco-editor'
import type { IOnigLib, IRawGrammar } from 'vscode-textmate'
import { TextMateLineLanguageCache } from '@/lib/monaco-languages/textmate-line-language-cache'

const SCRIPT_LANGUAGE = 1
const JSX_LANGUAGE = 2

export type JsxFileKind = 'jsx' | 'tsx'

type JsxProviderLoader = (fileKind: JsxFileKind) => Promise<Monaco.languages.EncodedTokensProvider>

type GrammarConfig = {
  scopeName: string
  fileName: string
  embeddedLanguages: Record<string, number>
  loadSource: () => Promise<string>
}

export type JsxCommentContext = 'jsx' | 'script' | 'unknown'

const GRAMMAR_CONFIGS: Record<JsxFileKind, GrammarConfig> = {
  // VS Code's React grammars are MIT-licensed; packaged notices live in resources/licenses.
  jsx: {
    scopeName: 'source.js.jsx',
    fileName: 'JavaScriptReact.tmLanguage.json',
    embeddedLanguages: {
      'meta.tag.js.jsx': JSX_LANGUAGE,
      'meta.tag.without-attributes.js.jsx': JSX_LANGUAGE,
      'meta.tag.attributes.js.jsx': SCRIPT_LANGUAGE,
      'meta.embedded.expression.js.jsx': SCRIPT_LANGUAGE
    },
    loadSource: async () =>
      (
        await import('@/lib/monaco-languages/textmate-grammars/javascript-react.tmLanguage.json?raw')
      ).default
  },
  tsx: {
    scopeName: 'source.tsx',
    fileName: 'TypeScriptReact.tmLanguage.json',
    embeddedLanguages: {
      'meta.tag.tsx': JSX_LANGUAGE,
      'meta.tag.without-attributes.tsx': JSX_LANGUAGE,
      'meta.tag.attributes.tsx': SCRIPT_LANGUAGE,
      'meta.embedded.expression.tsx': SCRIPT_LANGUAGE
    },
    loadSource: async () =>
      (
        await import('@/lib/monaco-languages/textmate-grammars/typescript-react.tmLanguage.json?raw')
      ).default
  }
}

const providerPromises: Partial<
  Record<JsxFileKind, Promise<Monaco.languages.EncodedTokensProvider>>
> = {}

function getJsxFileKind(filePath: string): JsxFileKind | null {
  const lowerPath = filePath.toLowerCase()
  if (lowerPath.endsWith('.tsx')) {
    return 'tsx'
  }
  if (lowerPath.endsWith('.jsx')) {
    return 'jsx'
  }
  return null
}

export async function createJsxCommentTokensProvider(
  fileKind: JsxFileKind,
  loadOniguruma?: () => Promise<IOnigLib>
): Promise<Monaco.languages.EncodedTokensProvider> {
  const config = GRAMMAR_CONFIGS[fileKind]
  const [source, textMate, providerModule] = await Promise.all([
    config.loadSource(),
    import('vscode-textmate'),
    import('@/lib/monaco-languages/textmate-token-provider')
  ])
  const grammar = textMate.parseRawGrammar(source, config.fileName)
  return providerModule.createTextMateEncodedTokensProvider({
    scopeName: config.scopeName,
    initialLanguage: SCRIPT_LANGUAGE,
    embeddedLanguages: config.embeddedLanguages,
    loadOniguruma,
    loadGrammar: async (scopeName): Promise<IRawGrammar | null> =>
      scopeName === config.scopeName ? grammar : null
  })
}

function loadProvider(fileKind: JsxFileKind): Promise<Monaco.languages.EncodedTokensProvider> {
  providerPromises[fileKind] ??= createJsxCommentTokensProvider(fileKind).catch(
    (error: unknown) => {
      delete providerPromises[fileKind]
      throw error
    }
  )
  return providerPromises[fileKind]
}

export class JsxCommentContextClassifier implements Monaco.IDisposable {
  private cache: TextMateLineLanguageCache | null = null
  private cachePromise: Promise<TextMateLineLanguageCache | null> | null = null
  private disposed = false

  constructor(
    private readonly model: Monaco.editor.ITextModel,
    private readonly fileKind: JsxFileKind,
    private readonly providerLoader: JsxProviderLoader
  ) {}

  async getContexts(lineNumbers: readonly number[]): Promise<JsxCommentContext[]> {
    const cache = await this.ensureCache()
    if (!cache) {
      return lineNumbers.map(() => 'unknown')
    }
    const languageIds = await cache.getLanguagesAtLineStarts(lineNumbers)
    return languageIds.map((languageId) => {
      if (languageId === JSX_LANGUAGE) {
        return 'jsx'
      }
      return languageId === SCRIPT_LANGUAGE ? 'script' : 'unknown'
    })
  }

  dispose(): void {
    this.disposed = true
    this.cache?.dispose()
    this.cache = null
  }

  private ensureCache(): Promise<TextMateLineLanguageCache | null> {
    if (this.disposed) {
      return Promise.resolve(null)
    }
    this.cachePromise ??= this.providerLoader(this.fileKind)
      .then((provider) => {
        if (this.disposed) {
          return null
        }
        this.cache = new TextMateLineLanguageCache(this.model, provider)
        return this.cache
      })
      .catch((error: unknown) => {
        this.cachePromise = null
        throw error
      })
    return this.cachePromise
  }
}

export function createJsxCommentContextClassifier(
  model: Monaco.editor.ITextModel,
  filePath: string,
  providerLoader: JsxProviderLoader = loadProvider
): JsxCommentContextClassifier | null {
  const fileKind = getJsxFileKind(filePath)
  return fileKind ? new JsxCommentContextClassifier(model, fileKind, providerLoader) : null
}
