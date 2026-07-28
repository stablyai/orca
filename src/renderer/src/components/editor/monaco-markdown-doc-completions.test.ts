import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MarkdownDocument } from '../../../../shared/types'
import { assertMarkdownDocumentsWithinLimit } from '../../../../shared/markdown-document-listing-limits'
import {
  clearMarkdownDocCompletionDocuments,
  getMarkdownCompletionDocumentsForTests,
  getMarkdownCompletionRefillCountForTests,
  getMarkdownCompletionRetentionForTests,
  MARKDOWN_COMPLETION_MAX_MODELS,
  MARKDOWN_COMPLETION_MAX_REFILLS,
  MARKDOWN_COMPLETION_MAX_SCOPES,
  resetMarkdownCompletionRetentionForTests,
  setMarkdownDocCompletionDocuments,
  setMarkdownDocCompletionRefill
} from './monaco-markdown-doc-completions'

function documents(scope: string): MarkdownDocument[] {
  return [
    {
      filePath: `/repo/${scope}.md`,
      relativePath: `${scope}.md`,
      basename: `${scope}.md`,
      name: scope
    }
  ]
}

afterEach(() => {
  resetMarkdownCompletionRetentionForTests()
})

describe('Monaco Markdown completion retention', () => {
  it('stores one document snapshot for every mounted model in the same worktree scope', () => {
    setMarkdownDocCompletionDocuments('model-a', 'worktree-a', documents('old'))
    const freshDocuments = documents('fresh')
    setMarkdownDocCompletionDocuments('model-b', 'worktree-a', freshDocuments)

    expect(getMarkdownCompletionRetentionForTests()).toEqual({
      models: 2,
      scopes: 1,
      retainedBytes: assertMarkdownDocumentsWithinLimit(freshDocuments)
    })

    clearMarkdownDocCompletionDocuments('model-a')
    expect(getMarkdownCompletionRetentionForTests()).toMatchObject({ models: 1, scopes: 1 })
    clearMarkdownDocCompletionDocuments('model-b')
    expect(getMarkdownCompletionRetentionForTests()).toEqual({
      models: 0,
      scopes: 0,
      retainedBytes: 0
    })
  })

  it('evicts oldest scopes and model associations at their exact caps', () => {
    for (let index = 0; index <= MARKDOWN_COMPLETION_MAX_SCOPES; index += 1) {
      setMarkdownDocCompletionDocuments(`model-${index}`, `scope-${index}`, documents(`${index}`))
    }
    expect(getMarkdownCompletionRetentionForTests()).toMatchObject({
      models: MARKDOWN_COMPLETION_MAX_SCOPES,
      scopes: MARKDOWN_COMPLETION_MAX_SCOPES
    })

    resetMarkdownCompletionRetentionForTests()
    for (let index = 0; index <= MARKDOWN_COMPLETION_MAX_MODELS; index += 1) {
      setMarkdownDocCompletionDocuments(`model-${index}`, 'shared-scope', documents('shared'))
    }
    expect(getMarkdownCompletionRetentionForTests()).toMatchObject({
      models: MARKDOWN_COMPLETION_MAX_MODELS,
      scopes: 1
    })
  })
})

describe('Monaco Markdown completion refill after eviction', () => {
  function mountModel(modelKey: string, scopeKey: string, scope: string): () => void {
    const refill = vi.fn(() => {
      setMarkdownDocCompletionDocuments(modelKey, scopeKey, documents(scope))
    })
    setMarkdownDocCompletionRefill(modelKey, refill)
    setMarkdownDocCompletionDocuments(modelKey, scopeKey, documents(scope))
    return refill
  }

  // Why: this is the regression. Evicting a still-mounted editor's documents used to leave it
  // offering zero completions until an unrelated prop changed — typing does not re-supply them.
  it('re-supplies documents for a still-mounted model whose scope was evicted', () => {
    const refill = mountModel('model-victim', 'scope-victim', 'victim')
    for (let index = 0; index <= MARKDOWN_COMPLETION_MAX_SCOPES; index += 1) {
      setMarkdownDocCompletionDocuments(`model-${index}`, `scope-${index}`, documents(`${index}`))
    }
    expect(getMarkdownCompletionRetentionForTests().scopes).toBe(MARKDOWN_COMPLETION_MAX_SCOPES)

    expect(getMarkdownCompletionDocumentsForTests('model-victim')).toEqual(documents('victim'))
    expect(refill).toHaveBeenCalledTimes(1)
  })

  it('serves cached documents without re-supplying when nothing was evicted', () => {
    const refill = mountModel('model-a', 'scope-a', 'a')

    expect(getMarkdownCompletionDocumentsForTests('model-a')).toEqual(documents('a'))
    expect(refill).not.toHaveBeenCalled()
  })

  it('reports no documents for a model that was never registered', () => {
    expect(getMarkdownCompletionDocumentsForTests('model-unknown')).toEqual([])
  })

  // Why: a refill that declines to store (non-markdown model, or an oversized document set)
  // must not loop or resurrect stale documents — an empty result is the correct answer.
  it('reports no documents when the refill declines to store any', () => {
    const refill = vi.fn()
    setMarkdownDocCompletionRefill('model-declines', refill)

    expect(getMarkdownCompletionDocumentsForTests('model-declines')).toEqual([])
    expect(refill).toHaveBeenCalledTimes(1)
  })

  it('stops re-supplying once the editor unmounts', () => {
    const refill = mountModel('model-gone', 'scope-gone', 'gone')
    clearMarkdownDocCompletionDocuments('model-gone')

    expect(getMarkdownCompletionDocumentsForTests('model-gone')).toEqual([])
    expect(refill).not.toHaveBeenCalled()
    expect(getMarkdownCompletionRefillCountForTests()).toBe(0)
  })

  it('bounds retained refills at their cap', () => {
    for (let index = 0; index <= MARKDOWN_COMPLETION_MAX_REFILLS; index += 1) {
      setMarkdownDocCompletionRefill(`model-${index}`, () => {})
    }

    expect(getMarkdownCompletionRefillCountForTests()).toBe(MARKDOWN_COMPLETION_MAX_REFILLS)
  })

  it('drops refills when the provider is torn down', () => {
    mountModel('model-a', 'scope-a', 'a')
    resetMarkdownCompletionRetentionForTests()

    expect(getMarkdownCompletionRefillCountForTests()).toBe(0)
  })
})
