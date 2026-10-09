import { describe, expect, it } from 'vitest'
import {
  createTestStore,
  makeOpenFile,
  makeTabGroup,
  makeUnifiedTab,
  seedStore
} from './store-test-helpers'
import { migrateHydratedEditorTabsAndGroups } from './editor/file-ids/hydrated-editor-file-ids'

const WT = 'wt-1'
const OLD = '/repo/a.ts'
const NEW = '/repo/renamed.ts'
const OTHER = '/repo/b.ts'

function clusteredEditorStore() {
  const store = createTestStore()
  seedStore(store, {
    openFiles: [
      makeOpenFile({ id: OLD, worktreeId: WT }),
      makeOpenFile({ id: OTHER, worktreeId: WT })
    ],
    unifiedTabsByWorktree: {
      [WT]: [
        makeUnifiedTab({ id: OLD, worktreeId: WT, groupId: 'primary', contentType: 'editor' }),
        makeUnifiedTab({ id: OTHER, worktreeId: WT, groupId: 'primary', contentType: 'editor' }),
        makeUnifiedTab({
          id: 'split-copy',
          entityId: OLD,
          worktreeId: WT,
          groupId: 'copy-pane',
          contentType: 'editor'
        })
      ]
    },
    groupsByWorktree: {
      [WT]: [
        makeTabGroup({
          id: 'primary',
          worktreeId: WT,
          activeTabId: OLD,
          tabOrder: [OLD, OTHER],
          tabClusters: [
            { id: 'work', name: 'Work', color: 'blue', collapsed: true, tabIds: [OLD, OTHER] }
          ]
        }),
        makeTabGroup({
          id: 'copy-pane',
          worktreeId: WT,
          activeTabId: 'split-copy',
          tabOrder: ['split-copy'],
          tabClusters: [
            { id: 'copy', name: '', color: 'red', collapsed: false, tabIds: ['split-copy'] }
          ]
        })
      ]
    }
  })
  return store
}

describe('editor cluster identifier compatibility', () => {
  it('retains cluster membership through a live file rename without rekeying split-copy ids', () => {
    const store = clusteredEditorStore()
    expect(
      store.getState().rekeyOpenFilesForPathChange({
        rekeys: [
          {
            oldFileId: OLD,
            newFileId: NEW,
            oldFilePath: OLD,
            newFilePath: NEW,
            newRelativePath: 'renamed.ts'
          }
        ]
      })
    ).toEqual({ ok: true })

    const groups = store.getState().groupsByWorktree[WT]
    expect(groups[0].tabOrder).toEqual([NEW, OTHER])
    expect(groups[0].tabClusters?.[0]).toEqual({
      id: 'work',
      name: 'Work',
      color: 'blue',
      collapsed: true,
      tabIds: [NEW, OTHER]
    })
    expect(groups[1].tabClusters?.[0].tabIds).toEqual(['split-copy'])
    expect(
      store.getState().unifiedTabsByWorktree[WT].find((tab) => tab.id === 'split-copy')?.entityId
    ).toBe(NEW)
  })

  it('retains membership when hydration migrates an editor id to its owned identity', () => {
    const store = clusteredEditorStore()
    store.setState(
      migrateHydratedEditorTabsAndGroups(store.getState(), { [WT]: new Map([[OLD, NEW]]) })
    )
    expect(store.getState().groupsByWorktree[WT][0].tabClusters?.[0].tabIds).toEqual([NEW, OTHER])
    expect(store.getState().groupsByWorktree[WT][1].tabClusters?.[0].tabIds).toEqual(['split-copy'])
  })
})
