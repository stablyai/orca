import { describe, expect, it } from 'vitest'
import { WorktreeSet } from './worktree-params'

const note = {
  id: 'note',
  worktreeId: 'wt',
  filePath: 'app.ts',
  lineNumber: 4,
  body: 'Review this',
  createdAt: 1,
  side: 'modified'
}

describe('worktree.set review notes', () => {
  it('keeps a whole-file note from the phone', () => {
    const fileNote = { ...note, id: 'file', lineNumber: 0 }
    expect(
      WorktreeSet.parse({ worktree: 'wt', diffComments: [note, fileNote] }).diffComments
    ).toEqual([note, fileNote])
  })

  it('refuses a note list it cannot read instead of dropping it and answering ok', () => {
    expect(
      WorktreeSet.safeParse({ worktree: 'wt', diffComments: [note, { id: 'broken', body: 'x' }] })
        .success
    ).toBe(false)
  })
})
