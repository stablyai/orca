import type { OnMount } from '@monaco-editor/react'
import type { IDisposable } from 'monaco-editor'
import type { MarkdownDocument } from '../../../../shared/types'
import {
  getMarkdownDocCompletionContext,
  getMarkdownDocCompletionDocuments
} from './markdown-doc-completions'

type MonacoApi = Parameters<OnMount>[1]

let provider: IDisposable | null = null
let providerMonaco: MonacoApi | null = null
const documentsByModel = new Map<string, MarkdownDocument[]>()

export function ensureMarkdownDocCompletionProvider(monaco: MonacoApi): void {
  // Why: if Monaco was torn down and re-created (e.g. window reload), the old
  // provider reference is stale. Detect this by checking whether the Monaco
  // instance changed and re-register.
  if (provider && providerMonaco === monaco) {
    return
  }
  if (provider) {
    provider.dispose()
    documentsByModel.clear()
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

      const documents = documentsByModel.get(model.uri.toString()) ?? []
      const suffix = line.slice(position.column - 1)
      const range = {
        startLineNumber: position.lineNumber,
        startColumn: position.column - context.partial.length,
        endLineNumber: position.lineNumber,
        endColumn: position.column
      }

      return {
        suggestions: getMarkdownDocCompletionDocuments(documents, context.partial).map(
          (document) => ({
            label: document.name,
            kind: monaco.languages.CompletionItemKind.File,
            detail: document.relativePath,
            insertText: suffix.startsWith(']]') ? document.name : `${document.name}]]`,
            range
          })
        )
      }
    }
  })
}

export function setMarkdownDocCompletionDocuments(
  modelKey: string,
  documents: MarkdownDocument[]
): void {
  documentsByModel.set(modelKey, documents)
}

export function clearMarkdownDocCompletionDocuments(modelKey: string): void {
  documentsByModel.delete(modelKey)
}
