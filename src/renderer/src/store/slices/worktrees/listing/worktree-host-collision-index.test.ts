/** STA-4343: repoId::path collides across hosts, so retain both workspaces for host-qualified selection. Deduplicate only same-host create/fetch races. */
import { describe, expect, it } from 'vitest'
import type { Worktree } from '../../../../../../shared/worktree/types'
import type { AppState } from '../../../types'
import { getWorktreeOnHostFromState } from '../../../workspaces/selection/worktree-on-host-selector'
import { getIndexedAllWorktrees } from './worktree-catalog-index'

const SHARED_ID = 'repo-1::/work/orca'

const baseWorktree: Worktree = {
  id: SHARED_ID,
  repoId: 'repo-1',
  path: '/work/orca',
  branch: 'refs/heads/feature',
  head: 'abc123',
  isBare: false,
  isMainWorktree: false,
  linkedIssue: null,
  linkedPR: null,
  linkedLinearIssue: null,
  isArchived: false,
  comment: '',
  isUnread: false,
  isPinned: false
} as Worktree

const localRow: Worktree = { ...baseWorktree, hostId: 'local', displayName: 'local orca' }
const sshRow: Worktree = { ...baseWorktree, hostId: 'ssh:build-box', displayName: 'ssh orca' }

function byRepo(...worktrees: Worktree[]): AppState['worktreesByRepo'] {
  return { 'repo-1': worktrees }
}

describe('id-keyed worktree projections keep distinct hosts distinct', () => {
  it('lists a colliding id once per host', () => {
    const all = getIndexedAllWorktrees(byRepo(localRow, sshRow))

    expect(all).toHaveLength(2)
    expect(all.map((entry) => entry.hostId)).toEqual(['local', 'ssh:build-box'])
  })
})

describe('getWorktreeOnHostFromState refuses a lookup that still matches two copies', () => {
  const colliding = { worktreesByRepo: byRepo(localRow, sshRow) }

  it('answers undefined for an unqualified id two hosts share', () => {
    expect(getWorktreeOnHostFromState(colliding, SHARED_ID, undefined)).toBeUndefined()
  })

  it('answers the named host copy', () => {
    expect(getWorktreeOnHostFromState(colliding, SHARED_ID, 'ssh:build-box')).toBe(sshRow)
  })
})
