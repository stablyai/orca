// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '../../store/types'
import {
  createTestStore,
  makeOpenFile,
  makeTabGroup,
  makeUnifiedTab,
  makeWorktree,
  seedStore,
  type TestStore
} from '../../store/slices/store-test-helpers'
import { getHiddenClusterTabIds } from '../../../../shared/tab-types'
import { useTabGroupCloseScopeCommands } from './useTabGroupCloseScopeCommands'
import { useTabGroupTabCloseCommands } from './useTabGroupTabCloseCommands'

const { getStateMock } = vi.hoisted(() => ({ getStateMock: vi.fn<() => AppState>() }))
vi.mock('../../store', () => ({
  useAppStore: Object.assign((selector: (state: AppState) => unknown) => selector(getStateMock()), {
    getState: getStateMock
  })
}))
vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))

const WT = 'repo1::/tmp/feature'
const PANE = 'pane'
const CLUSTER = 'cluster'
const ORDER = ['pinned', 'left', 'a', 'b', 'c', 'x']
let store: TestStore

function pane() {
  return store.getState().groupsByWorktree[WT][0]
}

function commands() {
  return renderHook(() => {
    const groupTabs = store
      .getState()
      .unifiedTabsByWorktree[WT].filter((tab) => tab.groupId === PANE)
    const closeCommands = useTabGroupTabCloseCommands({ worktreeId: WT })
    return useTabGroupCloseScopeCommands({
      worktreeId: WT,
      groupId: PANE,
      group: pane(),
      groupTabs,
      ...closeCommands
    })
  }).result.current
}

beforeEach(() => {
  vi.clearAllMocks()
  store = createTestStore()
  seedStore(store, {
    activeWorktreeId: WT,
    activeFileId: 'file-x',
    activeTabType: 'editor',
    activeGroupIdByWorktree: { [WT]: PANE },
    worktreesByRepo: { repo1: [makeWorktree({ id: WT, repoId: 'repo1' })] },
    openFiles: ORDER.map((id) => makeOpenFile({ id: `file-${id}`, worktreeId: WT })),
    unifiedTabsByWorktree: {
      [WT]: ORDER.map((id, sortOrder) =>
        makeUnifiedTab({
          id,
          entityId: `file-${id}`,
          contentType: 'editor',
          worktreeId: WT,
          groupId: PANE,
          sortOrder,
          isPinned: id === 'pinned'
        })
      ).toReversed()
    },
    groupsByWorktree: {
      [WT]: [
        makeTabGroup({
          id: PANE,
          worktreeId: WT,
          tabOrder: [...ORDER],
          activeTabId: 'x',
          recentTabIds: ['pinned', 'b', 'c', 'a', 'left', 'x'],
          tabClusters: [
            {
              id: CLUSTER,
              name: 'Work',
              color: 'blue',
              collapsed: true,
              shownTabId: 'a',
              tabIds: ['a', 'b', 'c']
            }
          ]
        })
      ]
    },
    layoutByWorktree: { [WT]: { type: 'leaf', groupId: PANE } }
  })
  getStateMock.mockImplementation(() => store.getState())
})

afterEach(cleanup)

describe('scope closes across a collapsed cluster', () => {
  it.each([
    { name: 'close-to-right', command: 'closeToRight', target: 'left', active: 'left' },
    { name: 'close-to-left', command: 'closeToLeft', target: 'x', active: 'x' },
    { name: 'close-others', command: 'closeOthers', target: 'left', active: 'left' }
  ] as const)(
    '$name includes hidden members and keeps pinned tabs',
    ({ command, target, active }) => {
      expect([...getHiddenClusterTabIds(pane())]).toEqual(['b', 'c'])
      const closeCommands = commands()
      act(() => closeCommands[command](target))

      expect(pane().tabOrder).toEqual(['pinned', target])
      expect(pane().tabClusters).toBeUndefined()
      expect(pane().activeTabId).toBe(active)
      expect(store.getState().getActiveTab(WT)?.id).toBe(active)
      expect(store.getState().activeFileId).toBe(`file-${active}`)
      expect(
        store
          .getState()
          .unifiedTabsByWorktree[WT].map((tab) => tab.id)
          .sort()
      ).toEqual(['pinned', target].sort())
      expect(store.getState().openFiles.map((file) => file.id)).toEqual([
        'file-pinned',
        `file-${target}`
      ])
      expect(store.getState().getTab('pinned')?.isPinned).toBe(true)
      expect(getHiddenClusterTabIds(pane()).has(active)).toBe(false)
    }
  )

  it('closing others around a hidden target selects a visible pinned successor without expanding', () => {
    const closeCommands = commands()
    act(() => closeCommands.closeOthers('b'))

    expect(pane().tabOrder).toEqual(['pinned', 'b'])
    expect(pane().activeTabId).toBe('pinned')
    expect(store.getState().activeFileId).toBe('file-pinned')
    expect(store.getState().getTab('pinned')?.isPinned).toBe(true)
    expect(pane().tabClusters).toEqual([
      { id: CLUSTER, name: 'Work', color: 'blue', collapsed: true, tabIds: ['b'] }
    ])
    expect([...getHiddenClusterTabIds(pane())]).toEqual(['b'])
    expect(
      store
        .getState()
        .unifiedTabsByWorktree[WT].map((tab) => tab.id)
        .sort()
    ).toEqual(['b', 'pinned'])
  })
})
