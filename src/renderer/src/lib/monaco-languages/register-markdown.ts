import type * as Monaco from 'monaco-editor'
import {
  buildMarkdownHeadingSections,
  type MarkdownHeadingSection
} from './markdown-heading-outline'

type MonacoModule = Pick<typeof Monaco, 'languages' | 'editor'>

const MARKDOWN_LANGUAGE_ID = 'markdown'

function toDocumentSymbol(
  monaco: MonacoModule,
  model: Monaco.editor.ITextModel,
  section: MarkdownHeadingSection
): Monaco.languages.DocumentSymbol {
  return {
    name: section.title || '#'.repeat(section.level),
    detail: '',
    kind: monaco.languages.SymbolKind.String,
    tags: [],
    range: {
      startLineNumber: section.startLine,
      startColumn: 1,
      endLineNumber: section.endLine,
      endColumn: model.getLineMaxColumn(section.endLine)
    },
    selectionRange: {
      startLineNumber: section.startLine,
      startColumn: 1,
      endLineNumber: section.headingEndLine,
      endColumn: model.getLineMaxColumn(section.headingEndLine)
    },
    children: section.children.map((child) => toDocumentSymbol(monaco, model, child))
  }
}

/** VS Code's markdown editing: TextMate colors, no bracket-pair colors, and a heading outline for sticky scroll. */
export function registerMarkdownLanguage(monaco: MonacoModule): void {
  // Why: Monaco merges configurations per field, so this keeps the built-in markdown config and drops only bracket colors.
  monaco.languages.setLanguageConfiguration(MARKDOWN_LANGUAGE_ID, { colorizedBracketPairs: [] })

  monaco.languages.registerTokensProviderFactory(MARKDOWN_LANGUAGE_ID, {
    // Monaco caches this result, so a TextMate load failure falls back to the built-in Monarch tokenizer.
    create: () =>
      import('./markdown-textmate-tokens')
        .then(({ createMarkdownTokensProvider }) => createMarkdownTokensProvider(monaco))
        .catch(async (error: unknown) => {
          console.warn('[markdown] TextMate highlighting failed to load; using Monarch', error)
          const { language } =
            await import('monaco-editor/esm/vs/basic-languages/markdown/markdown.js')
          return language
        })
  })

  monaco.languages.registerDocumentSymbolProvider(MARKDOWN_LANGUAGE_ID, {
    displayName: 'Markdown headings',
    provideDocumentSymbols: (model) =>
      buildMarkdownHeadingSections(model.getLinesContent()).map((section) =>
        toDocumentSymbol(monaco, model, section)
      )
  })
}
