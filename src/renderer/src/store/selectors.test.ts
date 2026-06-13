import { beforeEach, describe, expect, it } from 'vitest'
import type { Worktree } from '../../../shared/types'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import type { AppState } from './types'
import {
  getAllWorktreesFromState,
  getWorktreeMapFromState,
  resetFloatingVisibleTabCountSelectorCacheForTest,
  selectFloatingVisibleTabCount
} from './selectors'

function makeWorktree(args: { id: string; repoId: string; displayName: string }): Worktree {
  return {
    id: args.id,
    repoId: args.repoId,
    displayName: args.displayName,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    path: args.id,
    head: 'HEAD',
    branch: 'main',
    isBare: false,
    isMainWorktree: false
  }
}

describe('store selectors', () => {
  beforeEach(() => {
    resetFloatingVisibleTabCountSelectorCacheForTest()
  })

  it('deduplicates cached worktree snapshots without changing reference reuse', () => {
    const first = makeWorktree({ id: 'wt-1', repoId: 'repo-1', displayName: 'first' })
    const second = makeWorktree({ id: 'wt-2', repoId: 'repo-1', displayName: 'second' })
    const replacement = makeWorktree({
      id: 'wt-1',
      repoId: 'repo-2',
      displayName: 'replacement'
    })
    const state = {
      worktreesByRepo: {
        'repo-1': [first, second],
        'repo-2': [replacement]
      }
    }

    const allWorktrees = getAllWorktreesFromState(state)
    const worktreeMap = getWorktreeMapFromState(state)

    expect(allWorktrees).toEqual([replacement, second])
    expect(worktreeMap.get('wt-1')).toBe(replacement)
    expect(getAllWorktreesFromState(state)).toBe(allWorktrees)
    expect(getWorktreeMapFromState(state)).toBe(worktreeMap)
  })

  it('reuses the floating tab-count projection across unrelated store ticks', () => {
    const worktreeId = FLOATING_TERMINAL_WORKTREE_ID
    const terminalTabs = [
      {
        id: 'term-1',
        ptyId: null,
        worktreeId,
        title: 'Terminal',
        customTitle: null,
        color: null,
        sortOrder: 0,
        createdAt: 1
      }
    ] as AppState['tabsByWorktree'][string]
    const browserTabs = [{ id: 'browser-1' }] as AppState['browserTabsByWorktree'][string]
    let openFileScans = 0
    const fileEntries = [
      {
        id: 'file-1',
        filePath: '/tmp/file-1.ts',
        relativePath: 'file-1.ts',
        worktreeId,
        language: 'typescript',
        mode: 'edit',
        isDirty: false
      },
      {
        id: 'file-2',
        filePath: '/tmp/file-2.ts',
        relativePath: 'file-2.ts',
        worktreeId: 'repo::/elsewhere',
        language: 'typescript',
        mode: 'edit',
        isDirty: false
      }
    ] as AppState['openFiles']
    const openFiles = [...fileEntries] as AppState['openFiles']
    Object.defineProperty(openFiles, Symbol.iterator, {
      value: function* () {
        openFileScans += 1
        for (const entry of fileEntries) {
          yield entry
        }
      }
    })
    const unifiedTabs = [
      {
        id: 'unified-term-1',
        entityId: 'term-1',
        worktreeId,
        contentType: 'terminal',
        label: 'Terminal',
        sortOrder: 0,
        createdAt: 1
      },
      {
        id: 'unified-browser-1',
        entityId: 'browser-1',
        worktreeId,
        contentType: 'browser',
        label: 'Browser',
        sortOrder: 1,
        createdAt: 2
      },
      {
        id: 'unified-file-1',
        entityId: 'file-1',
        worktreeId,
        contentType: 'editor',
        label: 'file-1.ts',
        sortOrder: 2,
        createdAt: 3
      },
      {
        id: 'unified-stale-terminal',
        entityId: 'missing-term',
        worktreeId,
        contentType: 'terminal',
        label: 'Stale',
        sortOrder: 3,
        createdAt: 4
      }
    ] as AppState['unifiedTabsByWorktree'][string]
    const state = {
      tabsByWorktree: { [worktreeId]: terminalTabs },
      browserTabsByWorktree: { [worktreeId]: browserTabs },
      openFiles,
      unifiedTabsByWorktree: { [worktreeId]: unifiedTabs }
    } satisfies Parameters<typeof selectFloatingVisibleTabCount>[0]

    expect(selectFloatingVisibleTabCount(state)).toBe(3)
    expect(openFileScans).toBe(1)

    expect(selectFloatingVisibleTabCount({ ...state })).toBe(3)
    expect(openFileScans).toBe(1)
  })
})
