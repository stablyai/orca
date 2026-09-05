import { describe, expect, it } from 'vitest'
import { creationDraftInputSchema, creationDraftSchema } from './creation-draft-record'

const draft = {
  id: 'draft',
  title: 'Workspace',
  text: '',
  updatedAt: 1,
  agent: 'codex',
  executionHostId: 'local'
}

describe('creation draft validation', () => {
  it('bounds UTF-8 bytes rather than UTF-16 character count', () => {
    expect(
      creationDraftInputSchema.parse({ ...draft, text: '😀'.repeat(16384) }).text
    ).toHaveLength(32768)
    expect(() => creationDraftInputSchema.parse({ ...draft, text: '😀'.repeat(16385) })).toThrow()
  })

  it('accepts workspace ownership before a terminal binding exists', () => {
    expect(
      creationDraftSchema.parse({ ...draft, revision: 1, target: { worktreeId: 'workspace' } })
        .target
    ).toEqual({ worktreeId: 'workspace' })
  })

  it('preserves workspace IDs containing long host paths', () => {
    const worktreeId = `repo::${'nested/'.repeat(100)}workspace`
    expect(creationDraftInputSchema.parse({ ...draft, target: { worktreeId } }).target).toEqual({
      worktreeId
    })
  })

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN])(
    'rejects invalid revision %s',
    (revision) => {
      expect(() => creationDraftSchema.parse({ ...draft, revision })).toThrow()
    }
  )

  it('refuses malformed stored delivery and unknown fields', () => {
    expect(() =>
      creationDraftSchema.parse({
        ...draft,
        revision: 1,
        delivery: { attemptId: 'attempt', revision: 1, state: 'retry' }
      })
    ).toThrow()
    expect(() =>
      creationDraftSchema.parse({ ...draft, revision: 1, secret: 'unexpected' })
    ).toThrow()
  })
})
