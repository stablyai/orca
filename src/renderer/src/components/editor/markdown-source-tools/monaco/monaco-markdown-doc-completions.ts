import type { OnMount } from '@monaco-editor/react'
import type { IDisposable, editor } from 'monaco-editor'
import type { MarkdownDocument } from '../../../../../../shared/file-listing/file-document'
import { composeQuickOpenText } from '../../../../../../shared/quick-open/quick-open-path-search'
import {
  getMarkdownDocCompletionContext,
  getMarkdownDocCompletionDocuments
} from '../../markdown/documents/markdown-doc-completions'

type MonacoApi = Parameters<OnMount>[1]

let provider: IDisposable | null = null
let providerMonaco: MonacoApi = null
type ModelCompletionDocuments = {
  owners: Map<symbol, MarkdownDocument[]>
  documents: MarkdownDocument[]
}

let documentsByModel = new WeakMap<editor.ITextModel, ModelCompletionDocuments>()

export function ensureMarkdownDocCompletionProvider(monaco: MonacoApi): void {
  // Re-register when Monaco is recreated; the old provider belongs to the previous instance.
  if (provider && providerMonaco === monaco) {
    return
  }
  if (provider) {
    provider.dispose()
    documentsByModel = new WeakMap()
  }
  providerMonaco = monaco

  provider = monaco.languages.registerCompletionItemProvider('markdown', {
    triggerCharacters: ['['],
    provideCompletionItems(model, position) {
      const line = model.getLineContent(position.lineNumber)
      const context = getMarkdownDocCompletionContext(line.slice(0, position.column - 1))
      if (!context) {
        return { suggestions: [] }
      }

      const documents = documentsByModel.get(model)?.documents ?? []
      const suffix = line.slice(position.column - 1)
      const range = {
        startLineNumber: position.lineNumber,
        startColumn: position.column - context.partial.length,
        endLineNumber: position.lineNumber,
        endColumn: position.column
      }

      return {
        suggestions: getMarkdownDocCompletionDocuments(documents, context.partial).map(
          (document) => {
            const composedName = composeQuickOpenText(document.name)
            return {
              label: document.name,
              // Why: Monaco filters the typed text as is against filterText, cut at 128 characters.
              // The stored name goes first so every match the label alone had stays; the composed
              // name after it lets text typed composed (NFC) match a name stored decomposed (NFD).
              filterText:
                composedName === document.name ? document.name : `${document.name} ${composedName}`,
              kind: monaco.languages.CompletionItemKind.File,
              detail: document.relativePath,
              insertText: suffix.startsWith(']]') ? document.name : `${document.name}]]`,
              range
            }
          }
        )
      }
    }
  })
}

export function setMarkdownDocCompletionDocuments(
  model: editor.ITextModel,
  documents: MarkdownDocument[],
  owner: symbol
): void {
  const entry = documentsByModel.get(model) ?? { owners: new Map(), documents }
  entry.owners.delete(owner)
  entry.owners.set(owner, documents)
  entry.documents = documents
  documentsByModel.set(model, entry)
}

export function clearMarkdownDocCompletionDocuments(model: editor.ITextModel, owner: symbol): void {
  const entry = documentsByModel.get(model)
  if (!entry?.owners.delete(owner)) {
    return
  }
  if (entry.owners.size === 0) {
    documentsByModel.delete(model)
    return
  }
  // Closing the latest supplier restores the newest catalog still owned by a mounted pane.
  for (const documents of entry.owners.values()) {
    entry.documents = documents
  }
}
