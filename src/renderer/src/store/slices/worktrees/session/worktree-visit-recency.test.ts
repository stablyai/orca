import { describe, expect, it } from 'vitest'
import type { DetectedWorktree, Worktree } from '../../../../../../shared/worktree/types'
import { createTestStore } from '../../../testing/app-store-test-fixture'

const REPO = 'repo-1'
const SCANNED = `${REPO}::/w/main`
const CREATED = `${REPO}::/w/croaker`

function worktree(id: string): Worktree {
  return {
    id,
    repoId: REPO,
    path: id.slice(REPO.length + 2),
    head: 'abc',
    branch: 'refs/heads/main',
    isBare: false,
    isMainWorktree: id === SCANNED,
    displayName: id,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    hostId: 'local'
  }
}

function detected(id: string): DetectedWorktree {
  return { ...worktree(id), ownership: 'orca-managed', selectedCheckout: false, visible: true }
}

// The startup scan predates the create, so only the listing includes the new worktree.
function pruneWithActive(activeId: string, listedIds: string[]): string | null {
  const store = createTestStore()
  store.setState({
    activeWorktreeId: activeId,
    worktreesByRepo: { [REPO]: listedIds.map(worktree) },
    detectedWorktreesByRepo: {
      [REPO]: { repoId: REPO, authoritative: true, source: 'git', worktrees: [detected(SCANNED)] }
    }
  })
  store.getState().pruneLastVisitedTimestamps()
  return store.getState().activeWorktreeId
}

describe('pruneLastVisitedTimestamps active pointer', () => {
  it('keeps a worktree created after the startup scan selected', () => {
    expect(pruneWithActive(CREATED, [SCANNED, CREATED])).toBe(CREATED)
  })

  it('still clears a selection no list shows', () => {
    expect(pruneWithActive(`${REPO}::/w/removed`, [SCANNED])).toBeNull()
  })
})
