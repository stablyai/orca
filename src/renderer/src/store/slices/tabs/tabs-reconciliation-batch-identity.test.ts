import { describe, expect, it } from 'vitest'
import {
  createWorktreeTabModelReconciliationBatch,
  writeBatchedWorkspaceRecordEntry
} from './tabs-reconciliation-batch'
import { projectWorktreeTabModelReconciliation } from './tabs-reconciliation'
import { createTestStore } from '../store-test-helpers'

const WORKTREE = 'repo::/tmp/app'

describe('projectWorktreeTabModelReconciliation identity', () => {
  it('keeps every tab-model map when only an orphan runtime terminal changed', () => {
    const groupId = 'g-1'
    const store = createTestStore()
    store.setState({
      unifiedTabsByWorktree: {
        [WORKTREE]: [
          {
            id: 'sim-1',
            entityId: 'sim-1',
            groupId,
            worktreeId: WORKTREE,
            contentType: 'simulator',
            label: 'Simulator',
            customLabel: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      },
      groupsByWorktree: {
        [WORKTREE]: [
          {
            id: groupId,
            worktreeId: WORKTREE,
            activeTabId: 'sim-1',
            tabOrder: ['sim-1']
          }
        ]
      },
      activeGroupIdByWorktree: { [WORKTREE]: groupId },
      layoutByWorktree: { [WORKTREE]: { type: 'leaf', groupId } },
      // Orphan: a runtime terminal with no unified row and no live PTY.
      tabsByWorktree: {
        [WORKTREE]: [
          {
            id: 'orphan',
            ptyId: null,
            worktreeId: WORKTREE,
            title: 'Terminal',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      },
      ptyIdsByTabId: { orphan: [] }
    })
    const before = store.getState()

    const { patch } = projectWorktreeTabModelReconciliation(before, WORKTREE)

    expect(patch.tabsByWorktree?.[WORKTREE]).toEqual([])
    expect(patch.unifiedTabsByWorktree).toBe(before.unifiedTabsByWorktree)
    expect(patch.groupsByWorktree).toBe(before.groupsByWorktree)
    expect(patch.activeGroupIdByWorktree).toBe(before.activeGroupIdByWorktree)
    expect(patch.layoutByWorktree).toBeUndefined()
  })
})

describe('writeBatchedWorkspaceRecordEntry identity', () => {
  it('returns the same record when the entry already holds that value', () => {
    const groups = [{ id: 'group-1' }]
    const current = { [WORKTREE]: groups }

    const next = writeBatchedWorkspaceRecordEntry(
      current,
      'groupsByWorktree',
      WORKTREE,
      groups,
      undefined
    )

    // A new reference here rerenders every component selecting the map.
    expect(next).toBe(current)
  })

  it('does not claim ownership of a map it never cloned', () => {
    const groups = [{ id: 'group-1' }]
    const current = { [WORKTREE]: groups }
    const batch = createWorktreeTabModelReconciliationBatch({ openFiles: [] })

    const unchanged = writeBatchedWorkspaceRecordEntry(
      current,
      'groupsByWorktree',
      WORKTREE,
      groups,
      batch
    )
    expect(unchanged).toBe(current)
    expect(batch.ownedStateKeys.has('groupsByWorktree')).toBe(false)

    // A later real change must therefore still copy rather than mutate the caller's map.
    const changed = writeBatchedWorkspaceRecordEntry(
      current,
      'groupsByWorktree',
      WORKTREE,
      [{ id: 'group-2' }],
      batch
    )
    expect(changed).not.toBe(current)
    expect(current[WORKTREE]).toBe(groups)
    expect(batch.ownedStateKeys.has('groupsByWorktree')).toBe(true)
  })

  it('copies when the value differs', () => {
    const current = { [WORKTREE]: 'group-1' }

    const next = writeBatchedWorkspaceRecordEntry(
      current,
      'activeGroupIdByWorktree',
      WORKTREE,
      'group-2',
      undefined
    )

    expect(next).not.toBe(current)
    expect(next[WORKTREE]).toBe('group-2')
  })

  it('still stores an absent key, including an undefined value', () => {
    const current: Record<string, string | undefined> = { other: 'group-1' }

    const next = writeBatchedWorkspaceRecordEntry(
      current,
      'activeGroupIdByWorktree',
      WORKTREE,
      undefined,
      undefined
    )

    // The spread this replaces added the key; dropping it would change Object.keys.
    expect(next).not.toBe(current)
    expect(WORKTREE in next).toBe(true)
    expect(next[WORKTREE]).toBeUndefined()
  })

  it('keeps mutating in place once the batch owns the map', () => {
    const batch = createWorktreeTabModelReconciliationBatch({ openFiles: [] })
    batch.ownedStateKeys.add('groupsByWorktree')
    const draft: Record<string, unknown> = { [WORKTREE]: 'old' }

    const next = writeBatchedWorkspaceRecordEntry(draft, 'groupsByWorktree', WORKTREE, 'new', batch)

    expect(next).toBe(draft)
    expect(draft[WORKTREE]).toBe('new')
  })
})
