import { describe, expect, it } from 'vitest'
import type { LineageMember } from '../../../../../shared/lineage-discovery-types'
import { hasMembersBeyondTower } from './lineage-tower-members'

const child: LineageMember = {
  repoName: 'api',
  branch: 'feat/ABC-1',
  worktreeId: 'api::/w/api',
  worktreePath: '/w/api',
  matchedBy: 'pattern',
  reasons: []
}
const self: LineageMember = {
  repoName: 'tower',
  branch: 'feat/ABC-1',
  worktreeId: 'tower::/w/tower',
  worktreePath: '/w/tower',
  matchedBy: 'lineage',
  reasons: ['this workspace']
}
const active = { id: 'tower::/w/tower', path: '/w/tower' }

describe('hasMembersBeyondTower', () => {
  it('is false for no members', () => {
    expect(hasMembersBeyondTower([], active)).toBe(false)
  })

  it('is false when the only member is flagged as the tower', () => {
    expect(hasMembersBeyondTower([{ ...self, isTower: true }], null)).toBe(false)
  })

  it('is false for an unflagged self-only list matched by worktree id', () => {
    expect(hasMembersBeyondTower([self], { id: active.id, path: null })).toBe(false)
  })

  it('is false for an unflagged self-only list matched by worktree path', () => {
    const pathOnly: LineageMember = { ...self, worktreeId: undefined }
    expect(hasMembersBeyondTower([pathOnly], active)).toBe(false)
  })

  it('is true for an unflagged single member that is another worktree', () => {
    expect(hasMembersBeyondTower([child], active)).toBe(true)
  })

  it('is true when any member is not the tower', () => {
    expect(hasMembersBeyondTower([{ ...self, isTower: true }, child], active)).toBe(true)
  })

  it('is true for a worktree-less manual member', () => {
    const manual: LineageMember = {
      repoName: 'docs',
      branch: '',
      matchedBy: 'manual',
      reasons: [],
      pr: { number: 5 }
    }
    expect(hasMembersBeyondTower([manual], active)).toBe(true)
  })
})
