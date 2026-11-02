import { describe, expect, it, vi } from 'vitest'
import { searchWorktreeDocuments } from './worktree-palette-search'
import { buildWorktreePaletteDocuments } from './worktree-palette-document'
import type { Repo } from '../../../shared/repo-types'
import type { Worktree } from '../../../shared/worktree/types'
import { composeWorktreeHostIdentity } from '../../../shared/worktree/host-qualified-identity'

vi.mock('../../../shared/sidebar-inputs-switch', () => ({ ORCA_SIDEBAR_INPUTS_IS_MAIN: true }))

const worktree: Worktree = {
  id: 'repo-1::/tmp/shell-only',
  repoId: 'repo-1',
  hostId: 'local',
  path: '/tmp/shell-only',
  head: 'abc123',
  branch: 'refs/heads/shell-only',
  isBare: false,
  isMainWorktree: false,
  displayName: 'Shell only',
  comment: '',
  linkedIssue: null,
  linkedPR: null,
  linkedLinearIssue: null,
  isArchived: false,
  isUnread: false,
  isPinned: false,
  sortOrder: 0,
  lastActivityAt: 1_000
}
const repoMap = new Map<string, Repo>([
  ['repo-1', { id: 'repo-1', path: '/tmp/repo', displayName: 'Repo', badgeColor: '', addedAt: 0 }]
])

describe('jump palette last active with the switch on', () => {
  it('counts a visit to a plain-shell workspace as its last activity', () => {
    const visitedAt = 5_000
    for (const query of ['', 'shell']) {
      const [result] = searchWorktreeDocuments({
        worktrees: [worktree],
        query,
        documents: buildWorktreePaletteDocuments([worktree], { repoMap }),
        repoMap,
        context: { nowMs: 10_000 },
        lastVisitedAtByWorktreeId: {
          [composeWorktreeHostIdentity('local', worktree.id)]: visitedAt
        }
      })
      expect(result?.lastActiveAt).toBe(visitedAt)
    }
  })
})
