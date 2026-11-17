// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest'
import type { Worktree } from '../../../../shared/worktree/types'
import { useAppStore } from '@/store/index'
import {
  getIndexedAllWorktrees,
  getIndexedWorktreeById
} from '@/store/slices/worktrees/listing/worktree-catalog-index'
import { getLineageAncestorIndex } from '@/components/sidebar/worktree-list/listing/visible-worktree-indexes'
import { applyLocalPinnedDisplayName } from './pinned-display-name-apply'

const TITLE = 'Triage assigned issues prs'

function row(size: number, index: number, isArchived: boolean, onRead: () => void): Worktree {
  const worktree: Worktree = {
    id: `repo-${size}::/work/w${index}`,
    repoId: `repo-${size}`,
    path: `/work/w${index}`,
    head: 'aaa',
    branch: `refs/heads/w${index}`,
    isBare: false,
    isMainWorktree: false,
    displayName: index === 0 ? 'batfish-2' : `w${index}`,
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
      onRead()
      return isArchived
    }
  })
  return worktree
}

describe('applyLocalPinnedDisplayName', () => {
  it.each([750, 7500])('pins one title among %i rows without rescanning the catalog', (size) => {
    let otherReads = 0
    const countOtherRead = (): void => {
      otherReads++
    }
    // Row 0 is renamed and row 1 archived below; only the other rows' reads count.
    const rows = Array.from({ length: size }, (_, index) =>
      row(size, index, false, index < 2 ? () => {} : countOtherRead)
    )
    const repoId = `repo-${size}`
    useAppStore.setState({ worktreesByRepo: { [repoId]: rows }, detectedWorktreesByRepo: {} })
    getIndexedAllWorktrees(useAppStore.getState().worktreesByRepo)
    getLineageAncestorIndex(useAppStore.getState().worktreesByRepo)
    let senderLocations = 0
    const stopSenders = useAppStore
      .getState()
      .agentStatusByPaneKey.projection.subscribe('sender-locations', () => {
        senderLocations++
      })
    let writes = 0
    const stopWrites = useAppStore.subscribe(() => {
      writes++
    })
    otherReads = 0

    applyLocalPinnedDisplayName({ worktreeId: rows[0].id, displayName: TITLE })
    const pinned = useAppStore.getState().worktreesByRepo
    expect(getIndexedWorktreeById(pinned, rows[0].id)).toMatchObject({
      displayName: TITLE,
      displayNameMode: 'fixed'
    })
    const lineageRows = [...getLineageAncestorIndex(pinned).values()]
    expect(lineageRows.find(({ id }) => id === rows[0].id)?.displayName).toBe(TITLE)
    expect(otherReads).toBe(0)
    expect(senderLocations).toBe(0)
    // The pin and any sort-settle write it triggers; the identical pin below must add none.
    const writesAfterPin = writes
    expect(writesAfterPin).toBeGreaterThan(0)

    applyLocalPinnedDisplayName({ worktreeId: rows[0].id, displayName: TITLE })
    expect(useAppStore.getState().worktreesByRepo).toBe(pinned)
    expect(writes).toBe(writesAfterPin)
    expect(senderLocations).toBe(0)

    const archived = row(size, 1, true, () => {})
    useAppStore.setState({
      worktreesByRepo: { [repoId]: [pinned[repoId][0], archived, ...rows.slice(2)] }
    })
    expect(senderLocations).toBe(1)
    otherReads = 0
    const lineage = getLineageAncestorIndex(useAppStore.getState().worktreesByRepo)
    expect([...lineage.values()].some(({ id }) => id === archived.id)).toBe(false)
    expect(otherReads).toBe(size - 2)

    stopSenders()
    stopWrites()
  })
})
