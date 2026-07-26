import type { OnMount } from '@monaco-editor/react'
import type { IDisposable } from 'monaco-editor'
import type { MarkdownDocument } from '../../../../shared/types'
import {
  getMarkdownDocCompletionContext,
  getMarkdownDocCompletionDocuments
} from './markdown-doc-completions'
import { assertMarkdownDocumentsWithinLimit } from '../../../../shared/markdown-document-listing-limits'

type MonacoApi = Parameters<OnMount>[1]

type CompletionScope = {
  documents: MarkdownDocument[]
  modelKeys: Set<string>
  retainedBytes: number
}

export const MARKDOWN_COMPLETION_MAX_MODELS = 256
export const MARKDOWN_COMPLETION_MAX_SCOPES = 32
export const MARKDOWN_COMPLETION_MAX_RETAINED_BYTES = 64 * 1024 * 1024

let provider: IDisposable | null = null
let providerMonaco: MonacoApi | null = null
const scopeKeyByModel = new Map<string, string>()
const completionScopes = new Map<string, CompletionScope>()
let retainedBytes = 0

function deleteCompletionScope(scopeKey: string, scope: CompletionScope): void {
  completionScopes.delete(scopeKey)
  retainedBytes -= scope.retainedBytes
  for (const modelKey of scope.modelKeys) {
    scopeKeyByModel.delete(modelKey)
  }
}

function removeModel(modelKey: string): void {
  const scopeKey = scopeKeyByModel.get(modelKey)
  if (!scopeKey) {
    return
  }
  scopeKeyByModel.delete(modelKey)
  const scope = completionScopes.get(scopeKey)
  scope?.modelKeys.delete(modelKey)
  if (scope && scope.modelKeys.size === 0) {
    deleteCompletionScope(scopeKey, scope)
  }
}

function enforceCompletionRetentionLimits(): void {
  while (scopeKeyByModel.size > MARKDOWN_COMPLETION_MAX_MODELS) {
    const oldestModelKey = scopeKeyByModel.keys().next().value
    if (typeof oldestModelKey !== 'string') {
      break
    }
    removeModel(oldestModelKey)
  }
  while (
    completionScopes.size > MARKDOWN_COMPLETION_MAX_SCOPES ||
    retainedBytes > MARKDOWN_COMPLETION_MAX_RETAINED_BYTES
  ) {
    const oldest = completionScopes.entries().next().value
    if (!oldest) {
      break
    }
    deleteCompletionScope(oldest[0], oldest[1])
  }
}

function clearCompletionRetention(): void {
  scopeKeyByModel.clear()
  completionScopes.clear()
  retainedBytes = 0
}

export function ensureMarkdownDocCompletionProvider(monaco: MonacoApi): void {
  // Why: if Monaco was torn down and re-created (e.g. window reload), the old
  // provider reference is stale. Detect this by checking whether the Monaco
  // instance changed and re-register.
  if (provider && providerMonaco === monaco) {
    return
  }
  if (provider) {
    provider.dispose()
    clearCompletionRetention()
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

      const scopeKey = scopeKeyByModel.get(model.uri.toString())
      const documents = scopeKey ? (completionScopes.get(scopeKey)?.documents ?? []) : []
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
  scopeKey: string,
  documents: MarkdownDocument[]
): void {
  removeModel(modelKey)
  let nextRetainedBytes: number
  try {
    nextRetainedBytes = assertMarkdownDocumentsWithinLimit(documents)
  } catch {
    return
  }

  let scope = completionScopes.get(scopeKey)
  if (scope) {
    completionScopes.delete(scopeKey)
    retainedBytes -= scope.retainedBytes
    scope.documents = documents
    scope.retainedBytes = nextRetainedBytes
  } else {
    scope = { documents, modelKeys: new Set(), retainedBytes: nextRetainedBytes }
  }
  scope.modelKeys.add(modelKey)
  completionScopes.set(scopeKey, scope)
  scopeKeyByModel.set(modelKey, scopeKey)
  retainedBytes += nextRetainedBytes
  enforceCompletionRetentionLimits()
}

export function clearMarkdownDocCompletionDocuments(modelKey: string): void {
  removeModel(modelKey)
}

export function getMarkdownCompletionRetentionForTests(): {
  models: number
  scopes: number
  retainedBytes: number
} {
  return {
    models: scopeKeyByModel.size,
    scopes: completionScopes.size,
    retainedBytes
  }
}

export function resetMarkdownCompletionRetentionForTests(): void {
  clearCompletionRetention()
}
