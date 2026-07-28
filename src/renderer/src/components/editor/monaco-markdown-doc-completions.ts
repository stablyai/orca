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
/** A refill is a closure and a key, not a document snapshot — cheap enough to outnumber scopes. */
export const MARKDOWN_COMPLETION_MAX_REFILLS = 512

let provider: IDisposable | null = null
let providerMonaco: MonacoApi | null = null
const scopeKeyByModel = new Map<string, string>()
const completionScopes = new Map<string, CompletionScope>()
// Why: eviction can drop a scope whose editor is still mounted. Without a way to
// re-supply, that editor offers zero completions until an unrelated prop changes.
// The callback re-runs the editor's own update, so a miss behaves like a cache miss
// rather than a permanent failure. It survives eviction and is removed on unmount.
const refillByModel = new Map<string, () => void>()
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
  refillByModel.clear()
  retainedBytes = 0
}

/**
 * Documents for a model, re-fetching once from the owning editor if a retention limit
 * evicted them. Returns an empty list only when the model truly has no documents.
 */
function getCompletionDocuments(modelKey: string): MarkdownDocument[] {
  const cached = completionScopes.get(scopeKeyByModel.get(modelKey) ?? '')?.documents
  if (cached) {
    return cached
  }
  const refill = refillByModel.get(modelKey)
  if (!refill) {
    return []
  }
  refill()
  // Re-read rather than trusting the refill: it can legitimately decline to store
  // (non-markdown model, or a document set over the listing limit).
  return completionScopes.get(scopeKeyByModel.get(modelKey) ?? '')?.documents ?? []
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

      const documents = getCompletionDocuments(model.uri.toString())
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

/**
 * Register how to re-supply this model's documents after an eviction. The editor owns the
 * array either way, so holding the closure retains nothing the editor was not already
 * retaining. Call `clearMarkdownDocCompletionDocuments` on unmount to release it.
 */
export function setMarkdownDocCompletionRefill(modelKey: string, refill: () => void): void {
  // Re-insert so recency ordering reflects the latest mount, matching the eviction order.
  refillByModel.delete(modelKey)
  refillByModel.set(modelKey, refill)
  while (refillByModel.size > MARKDOWN_COMPLETION_MAX_REFILLS) {
    const oldest = refillByModel.keys().next().value
    if (typeof oldest !== 'string') {
      break
    }
    refillByModel.delete(oldest)
  }
}

export function clearMarkdownDocCompletionDocuments(modelKey: string): void {
  removeModel(modelKey)
  refillByModel.delete(modelKey)
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

export function getMarkdownCompletionDocumentsForTests(modelKey: string): MarkdownDocument[] {
  return getCompletionDocuments(modelKey)
}

export function getMarkdownCompletionRefillCountForTests(): number {
  return refillByModel.size
}

export function resetMarkdownCompletionRetentionForTests(): void {
  clearCompletionRetention()
}
