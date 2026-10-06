import { describe, expect, it } from 'vitest'
import { resolvePdfRelativeFileLinkSource } from './use-pdf-relative-file-link-opener'

describe('resolvePdfRelativeFileLinkSource', () => {
  it('roots a workspace PDF at the folder its relative path hangs from', () => {
    expect(
      resolvePdfRelativeFileLinkSource(
        { filePath: '/work/notes/out/notes.pdf', relativePath: 'out/notes.pdf', worktreeId: 'w1' },
        {}
      )
    ).toEqual({ worktreeRoot: '/work/notes' })
  })

  it('names the SSH host of a PDF opened from outside the worktree and gives it no root', () => {
    expect(
      resolvePdfRelativeFileLinkSource(
        {
          filePath: '/srv/build/notes.pdf',
          relativePath: '/srv/build/notes.pdf',
          worktreeId: 'w1',
          externalSshTargetId: 'ssh-target-1'
        },
        {}
      )
    ).toEqual({ worktreeRoot: null, sourceOwner: { kind: 'ssh', connectionId: 'ssh-target-1' } })
  })
})
