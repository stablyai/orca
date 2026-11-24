import { describe, expect, it } from 'vitest'
import type { DiffComment } from '../../../../../shared/file-review/diff-comment-types'
import {
  addKnownList,
  createKnownNoteVersions,
  recoveryWrite,
  RECOVERY_FULL_BASE_MAX_BYTES
} from './diff-comment-recovery-write'

function note(id: string, body: string): DiffComment {
  return {
    id,
    worktreeId: 'folder:folder-1',
    filePath: 'README.md',
    lineNumber: 1,
    body,
    side: 'modified',
    createdAt: 1
  }
}

describe('recovery write size', () => {
  it('never sends an untouched large note twice once the full base would not fit', () => {
    const large = note('large', 'x'.repeat(RECOVERY_FULL_BASE_MAX_BYTES / 2 + 1))
    const small = note('small', 'v1')
    const known = createKnownNoteVersions()
    addKnownList(known, [large, small])

    const write = recoveryWrite([large, small], [large, { ...small, body: 'v2' }], known)

    expect(write.diffComments.map(({ id, body }) => [id, body.length])).toEqual([
      ['large', large.body.length],
      ['small', 2]
    ])
    // Only the changed note's host version is the base, so the request carries the large note once.
    expect(write.diffCommentsBase).toEqual([small])
  })

  it("sends the host's whole list as the base while it fits", () => {
    const x = note('x', 'v1')
    const peer = note('peer', 'from another device')
    const known = createKnownNoteVersions()
    addKnownList(known, [x])

    const write = recoveryWrite([x, peer], [x, note('y', 'mine')], known)

    expect(write.diffCommentsBase).toEqual([x, peer])
    expect(write.diffComments.map(({ id }) => id)).toEqual(['x', 'peer', 'y'])
  })
})
