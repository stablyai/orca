import { describe, expect, it } from 'vitest'
import { DiffCommentSchema, parsePersistedDiffComments } from './diff-comment-schema'

function comment(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'note-1',
    worktreeId: 'repo::wt',
    filePath: 'README.md',
    lineNumber: 3,
    body: 'Review this',
    createdAt: 100,
    side: 'modified',
    ...overrides
  }
}

describe('DiffCommentSchema', () => {
  it('accepts a line note and a file-level note', () => {
    expect(DiffCommentSchema.safeParse(comment()).success).toBe(true)
    expect(DiffCommentSchema.safeParse(comment({ lineNumber: 0 })).success).toBe(true)
  })

  it('rejects empty identity and path fields', () => {
    for (const field of ['id', 'worktreeId', 'filePath']) {
      expect(DiffCommentSchema.safeParse(comment({ [field]: '' })).success).toBe(false)
    }
  })

  it('trims the body and rejects one with no content', () => {
    const parsed = DiffCommentSchema.safeParse(comment({ body: '  Review this  ' }))
    expect(parsed.success && parsed.data.body).toBe('Review this')
    expect(DiffCommentSchema.safeParse(comment({ body: '   ' })).success).toBe(false)
    expect(DiffCommentSchema.safeParse(comment({ body: '' })).success).toBe(false)
  })

  it('requires startLine to stay within the note range', () => {
    expect(DiffCommentSchema.safeParse(comment({ startLine: 3 })).success).toBe(true)
    expect(DiffCommentSchema.safeParse(comment({ startLine: 4 })).success).toBe(false)
    expect(DiffCommentSchema.safeParse(comment({ startLine: 0 })).success).toBe(false)
    expect(DiffCommentSchema.safeParse(comment({ lineNumber: 0, startLine: 1 })).success).toBe(
      false
    )
  })

  it('rejects a negative line number and a non-positive sentAt', () => {
    expect(DiffCommentSchema.safeParse(comment({ lineNumber: -1 })).success).toBe(false)
    expect(DiffCommentSchema.safeParse(comment({ lineNumber: 1.5 })).success).toBe(false)
    expect(DiffCommentSchema.safeParse(comment({ sentAt: 1 })).success).toBe(true)
    expect(DiffCommentSchema.safeParse(comment({ sentAt: 0 })).success).toBe(false)
    expect(DiffCommentSchema.safeParse(comment({ sentAt: -1 })).success).toBe(false)
  })
})

describe('parsePersistedDiffComments', () => {
  it('keeps valid notes and drops malformed ones', () => {
    expect(
      parsePersistedDiffComments([
        comment({ id: 'keep-1' }),
        comment({ id: '' }),
        { id: 'no-body', worktreeId: 'repo::wt', filePath: 'README.md' },
        'not-an-object',
        null,
        comment({ id: 'keep-2', lineNumber: 0 })
      ])
    ).toEqual([
      expect.objectContaining({ id: 'keep-1' }),
      expect.objectContaining({ id: 'keep-2' })
    ])
  })

  it('returns an empty list for non-array input', () => {
    expect(parsePersistedDiffComments(undefined)).toEqual([])
    expect(parsePersistedDiffComments({ length: 1 })).toEqual([])
  })
})
