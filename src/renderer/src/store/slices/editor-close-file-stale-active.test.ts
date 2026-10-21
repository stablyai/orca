import { describe, expect, it, vi } from 'vitest'
import {
  createTestStore,
  makeOpenFile,
  makeTabGroup,
  makeUnifiedTab,
  makeWorktree,
  seedStore
} from './store-test-helpers'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))

const WT = 'repo1::/repo1/wt'
const OTHER_WT = 'repo1::/repo1/other'
const G = `${WT}:group`

function seed(
  store: ReturnType<typeof createTestStore>,
  files: string[],
  tabs: [string, string][],
  active: string,
  recent: string[]
): void {
  seedStore(store, {
    worktreesByRepo: {
      repo1: [
        makeWorktree({ id: WT, repoId: 'repo1', path: '/repo1/wt' }),
        makeWorktree({ id: OTHER_WT, repoId: 'repo1', path: '/repo1/other' })
      ]
    },
    activeWorktreeId: WT,
    openFiles: [
      makeOpenFile({ id: '/other', worktreeId: OTHER_WT }),
      ...files.map((id) => makeOpenFile({ id, worktreeId: WT }))
    ],
    activeFileId: files[0],
    activeTabType: 'editor',
    activeFileIdByWorktree: { [WT]: files[0] },
    unifiedTabsByWorktree: {
      [WT]: tabs.map(([id, entityId]) =>
        makeUnifiedTab({ id, entityId, worktreeId: WT, groupId: G, contentType: 'editor' })
      )
    },
    groupsByWorktree: {
      [WT]: [
        makeTabGroup({
          id: G,
          worktreeId: WT,
          activeTabId: active,
          tabOrder: tabs.map(([id]) => id),
          recentTabIds: recent
        })
      ]
    },
    activeGroupIdByWorktree: { [WT]: G }
  })
}

function expectValidActiveFile(store: ReturnType<typeof createTestStore>): void {
  const { activeFileId, openFiles } = store.getState()
  if (activeFileId !== null) {
    expect(openFiles.find((f) => f.id === activeFileId)?.worktreeId).toBe(WT)
  }
}

describe('closeFile when activeFileId is not an open file', () => {
  it('closes an editor tab whose file is gone without throwing', () => {
    const store = createTestStore()
    seed(
      store,
      ['/a', '/b'],
      [
        ['t-a', '/a'],
        ['t-ghost', '/ghost'],
        ['t-b', '/b']
      ],
      't-a',
      ['t-ghost', 't-a']
    )
    store.getState().closeFile('/a')
    // Closing '/a' promotes the orphan tab, leaving activeFileId on a file that is not open.
    expect(store.getState().activeFileId).toBe('/ghost')

    expect(() => store.getState().closeFile('/ghost')).not.toThrow()
    expect(store.getState().activeFileId).toBe('/b')
    expectValidActiveFile(store)
  })

  it('finishes close-all when the open-file list has a duplicate id', () => {
    const store = createTestStore()
    seed(
      store,
      ['/a', '/a', '/b'],
      [
        ['t-a1', '/a'],
        ['t-a2', '/a'],
        ['t-b', '/b']
      ],
      't-a1',
      ['t-a2', 't-a1']
    )
    const closable = store.getState().openFiles.filter((f) => f.worktreeId === WT)
    expect(() => {
      for (const file of closable) {
        store.getState().closeFile(file.id)
      }
    }).not.toThrow()
    const state = store.getState()
    expect(state.openFiles.map((f) => f.id)).toEqual(['/other'])
    expect(state.unifiedTabsByWorktree[WT] ?? []).toEqual([])
    expect(state.activeFileId).toBeNull()
  })

  it('does not select another worktree file after close-all clears the active worktree', () => {
    const store = createTestStore()
    seed(
      store,
      ['/a', '/b', '/a'],
      [
        ['t-a1', '/a'],
        ['t-b', '/b'],
        ['t-a2', '/a']
      ],
      't-a1',
      ['t-a2', 't-a1']
    )
    const closable = store.getState().openFiles.filter((f) => f.worktreeId === WT)

    for (const file of closable) {
      store.getState().closeFile(file.id)
    }

    const state = store.getState()
    expect(state.openFiles.map((f) => f.id)).toEqual(['/other'])
    expect(state.unifiedTabsByWorktree[WT] ?? []).toEqual([])
    expect(state.activeWorktreeId).toBeNull()
    expect(state.activeFileId).toBeNull()
  })
})
