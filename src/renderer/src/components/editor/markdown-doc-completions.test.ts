import { describe, expect, it } from 'vitest'
import type { MarkdownDocument } from '../../../../shared/types'
import {
  getMarkdownDocCompletionContext,
  getMarkdownDocCompletionDocuments
} from './markdown-doc-completions'

const documents: MarkdownDocument[] = [
  {
    filePath: '/repo/docs/setup.md',
    relativePath: 'docs/setup.md',
    basename: 'setup.md',
    name: 'setup'
  },
  {
    filePath: '/repo/notes/plan.md',
    relativePath: 'notes/plan.md',
    basename: 'plan.md',
    name: 'plan'
  }
]

describe('getMarkdownDocCompletionContext', () => {
  it('detects partial doc links', () => {
    expect(getMarkdownDocCompletionContext('before [[se')).toEqual({ partial: 'se' })
  })

  it('supports an empty partial after opening brackets', () => {
    expect(getMarkdownDocCompletionContext('[[')).toEqual({ partial: '' })
  })

  it('rejects closed or malformed contexts', () => {
    expect(getMarkdownDocCompletionContext('[[done]]')).toBeNull()
    expect(getMarkdownDocCompletionContext('plain text')).toBeNull()
  })
})

describe('getMarkdownDocCompletionDocuments', () => {
  it('filters by name or relative path', () => {
    expect(getMarkdownDocCompletionDocuments(documents, 'do')).toEqual([documents[0]])
    expect(getMarkdownDocCompletionDocuments(documents, 'notes/pl')).toEqual([documents[1]])
  })

  it('normalizes Windows-style partial paths', () => {
    expect(getMarkdownDocCompletionDocuments(documents, 'docs\\se')).toEqual([documents[0]])
  })
})
