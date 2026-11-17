import { describe, expect, it, vi } from 'vitest'
import type { Worktree } from '../../../../../shared/worktree/types'
import { createLiveWorktreeCounter } from './settled-sort-epoch'
import { getIndexedAllWorktrees } from '../worktrees/listing/worktree-catalog-index'
import type * as CatalogIndex from '../worktrees/listing/worktree-catalog-index'

vi.mock('../worktrees/listing/worktree-catalog-index', async (importOriginal) => {
  const actual = await importOriginal<typeof CatalogIndex>()
  return { ...actual, getIndexedAllWorktrees: vi.fn(actual.getIndexedAllWorktrees) }
})

function row(index: number, isArchived: boolean, onArchivedRead: () => void): Worktree {
  const worktree: Worktree = {
    id: `repo-1::/work/w${index}`,
    repoId: 'repo-1',
    path: `/work/w${index}`,
    head: 'aaa',
    branch: `refs/heads/w${index}`,
    isBare: false,
    isMainWorktree: false,
    displayName: `w${index}`,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0
  }
  Object.defineProperty(worktree, 'isArchived', {
    enumerable: true,
    get: () => {
      onArchivedRead()
      return isArchived
    }
  })
  return worktree
}

describe('createLiveWorktreeCounter', () => {
  it.each([750, 7500])('a title change with %i rows reads no other row', (size) => {
    let otherReads = 0
    const countOtherRead = (): void => {
      otherReads++
    }
    // Row 0 is the renamed row; only the other rows' reads count.
    const rows = Array.from({ length: size }, (_, index) =>
      row(index, false, index === 0 ? () => {} : countOtherRead)
    )
    const countLive = createLiveWorktreeCounter()
    expect(countLive({ 'repo-1': rows })).toBe(size)
    vi.mocked(getIndexedAllWorktrees).mockClear()
    otherReads = 0

    const renamed = [{ ...row(0, false, () => {}), displayName: 'Triage assigned issues prs' }]
    expect(countLive({ 'repo-1': [...renamed, ...rows.slice(1)] })).toBe(size)
    expect(otherReads).toBe(0)
    expect(getIndexedAllWorktrees).not.toHaveBeenCalled()

    const archived = [...renamed, row(1, true, () => {}), ...rows.slice(2)]
    expect(countLive({ 'repo-1': archived })).toBe(size - 1)
  })
})
