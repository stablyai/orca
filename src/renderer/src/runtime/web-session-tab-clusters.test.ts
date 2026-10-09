import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TabGroup } from '../../../shared/tab-types'
import {
  createTestStore,
  makeOpenFile,
  makeUnifiedTab,
  seedStore
} from '../store/slices/store-test-helpers'
import { applyWebSessionTabsSnapshot } from './web-session-tabs-sync'
import {
  ENV,
  NOW,
  WT,
  makeSnapshot,
  makeState,
  resetWebSessionTabsSyncTestState
} from './web-session-tabs-sync-test-harness'

vi.mock('../store', () => ({
  useAppStore: { setState: vi.fn() }
}))

beforeEach(resetWebSessionTabsSyncTestState)

const group: TabGroup = {
  id: 'pane',
  worktreeId: WT,
  activeTabId: 'local-b',
  tabOrder: ['local-a', 'local-b'],
  tabClusters: [
    {
      id: 'work',
      name: 'Work',
      color: 'blue',
      collapsed: true,
      tabIds: ['local-a', 'local-b'],
      shownTabId: 'local-b'
    }
  ]
}

describe('web-session cluster presentation', () => {
  it('keeps client-owned placement and cluster membership when a host snapshot adopts an editor', () => {
    const store = createTestStore()
    seedStore(
      store,
      makeState({
        activeFileId: '/repo/b.md',
        activeFileIdByWorktree: { [WT]: '/repo/b.md' },
        activeTabType: 'editor',
        activeTabTypeByWorktree: { [WT]: 'editor' },
        activeGroupIdByWorktree: { [WT]: group.id },
        groupsByWorktree: { [WT]: [group] },
        layoutByWorktree: { [WT]: { type: 'leaf', groupId: group.id } },
        openFiles: ['a', 'b'].map((name) =>
          makeOpenFile({
            id: `/repo/${name}.md`,
            worktreeId: WT,
            relativePath: `${name}.md`,
            language: 'markdown',
            runtimeEnvironmentId: ENV
          })
        ),
        unifiedTabsByWorktree: {
          [WT]: ['a', 'b'].map((name, sortOrder) =>
            makeUnifiedTab({
              id: `local-${name}`,
              entityId: `/repo/${name}.md`,
              worktreeId: WT,
              groupId: group.id,
              contentType: 'editor',
              sortOrder
            })
          )
        }
      })
    )

    store.setState((state) =>
      applyWebSessionTabsSnapshot(
        state,
        makeSnapshot(
          ['b', 'a'].map((name) => ({
            type: 'markdown' as const,
            id: name === 'b' ? 'mirrored-b' : 'local-a',
            title: `${name}.md`,
            filePath: `/repo/${name}.md`,
            relativePath: `${name}.md`,
            language: 'markdown',
            mode: 'edit' as const,
            isDirty: false,
            isActive: name === 'a',
            sourceFileId: `/repo/${name}.md`,
            sourceFilePath: `/repo/${name}.md`,
            sourceRelativePath: `${name}.md`,
            documentVersion: `file:/repo/${name}.md`
          })),
          {
            activeGroupId: 'host-pane',
            activeTabId: 'local-a',
            activeTabType: 'markdown',
            tabGroups: [
              {
                id: 'host-pane',
                activeTabId: 'local-a',
                tabOrder: ['mirrored-b', 'local-a']
              }
            ],
            tabGroupLayout: { type: 'leaf', groupId: 'host-pane' }
          }
        ),
        ENV,
        NOW
      )
    )

    const state = store.getState()
    expect(state.groupsByWorktree[WT]).toMatchObject([
      {
        id: group.id,
        tabOrder: ['local-a', 'mirrored-b'],
        activeTabId: 'mirrored-b',
        tabClusters: [
          {
            id: 'work',
            name: 'Work',
            color: 'blue',
            collapsed: true,
            tabIds: ['local-a', 'mirrored-b'],
            shownTabId: 'mirrored-b'
          }
        ]
      }
    ])
    expect(state.layoutByWorktree[WT]).toEqual({ type: 'leaf', groupId: group.id })
    expect(state.getTab('mirrored-b')).toMatchObject({
      entityId: '/repo/b.md',
      groupId: group.id
    })
    expect(state.getTab('local-b')).toBeNull()
  })
})
