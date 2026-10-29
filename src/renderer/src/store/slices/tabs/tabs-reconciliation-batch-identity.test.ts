import { editSessionSource, unwrapSessionSourceWrite } from '../../session-source-edits'
import { setSessionTestState } from '@/lib/test-support/session-source-fixture'
import { describe, expect, it } from 'vitest'
import { projectWorktreeTabModelReconciliation } from './tabs-reconciliation'
import { createTestStore } from '../store-test-helpers'

const WORKTREE = 'repo::/tmp/app'

describe('projectWorktreeTabModelReconciliation identity', () => {
  it('keeps every tab-model map when only an orphan runtime terminal changed', () => {
    const groupId = 'g-1'
    const store = createTestStore()
    setSessionTestState(store, {
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

    const edit = editSessionSource(before)
    const result = projectWorktreeTabModelReconciliation(edit, WORKTREE)
    const patch = unwrapSessionSourceWrite(edit.finish(result.patch)).partial

    expect(patch.tabsByWorktree?.[WORKTREE]).toEqual([])
    expect(edit.read('unifiedTabsByWorktree')).toBe(before.unifiedTabsByWorktree)
    expect(edit.read('groupsByWorktree')).toBe(before.groupsByWorktree)
    expect(edit.read('activeGroupIdByWorktree')).toBe(before.activeGroupIdByWorktree)
    expect(patch.layoutByWorktree).toBeUndefined()
  })
})

describe('shared reconciliation edit identity', () => {
  it('keeps equal entries and copies once across sequential workspaces with frozen priors', () => {
    const current: Readonly<Record<string, string | undefined>> = Object.freeze({
      first: 'one',
      second: 'two'
    })
    const edit = editSessionSource({ activeGroupIdByWorktree: current })
    edit.set('activeGroupIdByWorktree', 'first', 'one')
    expect(edit.read('activeGroupIdByWorktree')).toBe(current)
    edit.set('activeGroupIdByWorktree', 'first', 'changed')
    const owned = edit.read('activeGroupIdByWorktree')
    edit.set('activeGroupIdByWorktree', 'second', 'next')
    edit.set('activeGroupIdByWorktree', 'absent', undefined)
    expect(edit.read('activeGroupIdByWorktree')).toBe(owned)
    expect(
      Object.keys(unwrapSessionSourceWrite(edit.finish()).partial.activeGroupIdByWorktree!)
    ).toEqual(['first', 'second', 'absent'])
    expect(current).toEqual({ first: 'one', second: 'two' })
  })
})
