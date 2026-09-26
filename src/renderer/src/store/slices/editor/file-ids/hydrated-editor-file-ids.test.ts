import { describe, expect, it } from 'vitest'
import type { Tab, TabGroup } from '../../../../../../shared/tab-types'
import { migrateHydratedEditorTabsAndGroups } from './hydrated-editor-file-ids'

const WORKTREE_ID = 'wt-1'
const FILE_PATH = '/w/a.txt'
const RUNTIME_FILE_ID = `editor:${WORKTREE_ID}:env-1:${FILE_PATH}`

function editorTab(id: string, entityId: string, groupId = 'g1'): Tab {
  return {
    id,
    entityId,
    groupId,
    worktreeId: WORKTREE_ID,
    contentType: 'editor',
    label: 'a.txt',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

function group(id: string, tabIds: string[], activeTabId: string): TabGroup {
  return {
    id,
    worktreeId: WORKTREE_ID,
    activeTabId,
    tabOrder: tabIds,
    recentTabIds: tabIds
  }
}

/** The heal redirects the runtime-owned record onto the local survivor's id. */
const MIGRATIONS = { [WORKTREE_ID]: new Map([[RUNTIME_FILE_ID, FILE_PATH]]) }

describe('migrateHydratedEditorTabsAndGroups', () => {
  it('collapses two tabs the migration redirects onto one document in one group', () => {
    const state = {
      unifiedTabsByWorktree: {
        [WORKTREE_ID]: [
          editorTab('tab-local', FILE_PATH),
          editorTab('tab-runtime', RUNTIME_FILE_ID)
        ]
      },
      groupsByWorktree: {
        [WORKTREE_ID]: [group('g1', ['tab-local', 'tab-runtime'], 'tab-runtime')]
      }
    }

    const next = migrateHydratedEditorTabsAndGroups(state, MIGRATIONS)

    expect(next.unifiedTabsByWorktree?.[WORKTREE_ID].map((tab) => tab.id)).toEqual(['tab-local'])
    const healedGroup = next.groupsByWorktree?.[WORKTREE_ID][0]
    expect(healedGroup?.tabOrder).toEqual(['tab-local'])
    expect(healedGroup?.recentTabIds).toEqual(['tab-local'])
    // Repointed at the survivor rather than nulled: the user's active tab is still that document.
    expect(healedGroup?.activeTabId).toBe('tab-local')
  })

  it('keeps the merged tab pinned when the dropped twin was the pinned one', () => {
    const state = {
      unifiedTabsByWorktree: {
        [WORKTREE_ID]: [
          editorTab('tab-local', FILE_PATH),
          { ...editorTab('tab-runtime', RUNTIME_FILE_ID), isPinned: true, color: 'red' }
        ]
      },
      groupsByWorktree: {
        [WORKTREE_ID]: [group('g1', ['tab-local', 'tab-runtime'], 'tab-runtime')]
      }
    }

    const next = migrateHydratedEditorTabsAndGroups(state, MIGRATIONS)

    expect(next.unifiedTabsByWorktree?.[WORKTREE_ID]).toEqual([
      expect.objectContaining({ id: 'tab-local', isPinned: true, color: 'red' })
    ])
  })

  it('keeps one tab per group when the redirected tabs are in different groups', () => {
    const state = {
      unifiedTabsByWorktree: {
        [WORKTREE_ID]: [
          editorTab('tab-left', FILE_PATH, 'g1'),
          editorTab('tab-right', RUNTIME_FILE_ID, 'g2')
        ]
      },
      groupsByWorktree: {
        [WORKTREE_ID]: [
          group('g1', ['tab-left'], 'tab-left'),
          group('g2', ['tab-right'], 'tab-right')
        ]
      }
    }

    const next = migrateHydratedEditorTabsAndGroups(state, MIGRATIONS)

    expect(next.unifiedTabsByWorktree?.[WORKTREE_ID].map((tab) => tab.id)).toEqual([
      'tab-left',
      'tab-right'
    ])
    // No tab died, so the groups need no repoint at all.
    expect(next.groupsByWorktree).toBeUndefined()
  })

  it('leaves tabs for distinct documents alone', () => {
    const state = {
      unifiedTabsByWorktree: {
        [WORKTREE_ID]: [editorTab('tab-a', FILE_PATH), editorTab('tab-b', '/w/b.txt')]
      },
      groupsByWorktree: {
        [WORKTREE_ID]: [group('g1', ['tab-a', 'tab-b'], 'tab-b')]
      }
    }

    const next = migrateHydratedEditorTabsAndGroups(state, MIGRATIONS)

    expect(next).toEqual({})
  })
})
