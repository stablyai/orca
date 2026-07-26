import { afterEach, describe, expect, it } from 'vitest'
import type { MarkdownDocument } from '../../../../shared/types'
import { assertMarkdownDocumentsWithinLimit } from '../../../../shared/markdown-document-listing-limits'
import {
  clearMarkdownDocCompletionDocuments,
  getMarkdownCompletionRetentionForTests,
  MARKDOWN_COMPLETION_MAX_MODELS,
  MARKDOWN_COMPLETION_MAX_SCOPES,
  resetMarkdownCompletionRetentionForTests,
  setMarkdownDocCompletionDocuments
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
