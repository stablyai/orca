import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { recordLayoutApply } from '@/runtime/layout-apply-send'
import { insertUnifiedTabAfterAnchor } from '@/lib/unified-tab-anchor-insertion'
import { workspaceRootGroupId } from '../../../../../shared/workspace-layout/workspace-layout-minted-ids'
import type { Tab } from '../../../../../shared/tab-types'
import { restoreRecentlyClosedTabPosition } from '../recently-closed-tab-position'
import { createTestStore } from '../store-test-helpers'
import { createTabsSliceMockApi } from '../tabs-slice-test-harness'

const mocks = vi.hoisted(() => {
  const held: { send: ReturnType<typeof vi.fn<typeof recordLayoutApply>>; store: unknown } = {
    send: vi.fn<typeof recordLayoutApply>(),
    store: null
  }
  return held
})

vi.mock('../../../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))
vi.mock('@/runtime/layout-apply-send', () => ({ recordLayoutApply: mocks.send }))
vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('@/store', () => ({
  get useAppStore() {
    return mocks.store
  }
}))

createTabsSliceMockApi()

const WT = 'repo1::/path/wt1'
const GROUP = 'group-1'

function tab(id: string, extra: Partial<Tab> = {}): Tab {
  return {
    id,
    entityId: id,
    groupId: GROUP,
    worktreeId: WT,
    contentType: 'browser',
    label: id,
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 1,
    ...extra
  }
}

function seeded(tabs: Tab[]) {
  const store = createTestStore()
  store.setState({
    unifiedTabsByWorktree: { [WT]: tabs },
    groupsByWorktree: {
      [WT]: [{ id: GROUP, worktreeId: WT, activeTabId: null, tabOrder: tabs.map((t) => t.id) }]
    },
    activeGroupIdByWorktree: { [WT]: GROUP }
  })
  mocks.store = store
  return store
}

const moves = () =>
  mocks.send.mock.calls.flatMap(([, worktreeId, command]) =>
    command.type === 'moveTab' ? [{ worktreeId, ...command }] : []
  )

beforeEach(() => {
  mocks.send.mockReset()
})

describe('group ids in a layout-owner build', () => {
  it('names a workspace’s first group as main and the Loader do', () => {
    const store = createTestStore()
    store.getState().createUnifiedTab(WT, 'browser', { id: 'tab-a', entityId: 'tab-a' })

    expect(store.getState().groupsByWorktree[WT]?.map((group) => group.id)).toEqual([
      workspaceRootGroupId(WT)
    ])
  })
})

describe('tab activation in a layout-owner build', () => {
  it('ends a preview without writing a preview flag main does not store', () => {
    const store = seeded([tab('tab-a'), tab('tab-b', { isPreview: true })])

    store.getState().activateTab('tab-a')
    store.getState().activateTab('tab-b')

    const [a, b] = store.getState().unifiedTabsByWorktree[WT]!
    expect(a).not.toHaveProperty('isPreview')
    expect(b).not.toHaveProperty('isPreview')
  })

  it('keeps a preview, and writes no flag, when the activation preserves it', () => {
    const store = seeded([tab('tab-a'), tab('tab-b', { isPreview: true })])

    store.getState().activateTab('tab-a', { preservePreview: true })
    store.getState().activateTab('tab-b', { preservePreview: true })

    const [a, b] = store.getState().unifiedTabsByWorktree[WT]!
    expect(a).not.toHaveProperty('isPreview')
    expect(b?.isPreview).toBe(true)
  })
})

describe('tab order in a layout-owner build', () => {
  it('records an anchored insert as one move of the inserted tab', () => {
    seeded([tab('tab-a'), tab('tab-b'), tab('tab-c')])

    insertUnifiedTabAfterAnchor(WT, 'tab-c', 'tab-a')

    expect(moves()).toEqual([
      { worktreeId: WT, type: 'moveTab', tabId: 'tab-c', toGroupId: GROUP, index: 1 }
    ])
  })

  it('records a reversed order as moves main replays to the same order', () => {
    const store = seeded([tab('tab-a'), tab('tab-b'), tab('tab-c')])

    store.getState().reorderUnifiedTabs(GROUP, ['tab-c', 'tab-b', 'tab-a'])

    let order = ['tab-a', 'tab-b', 'tab-c']
    for (const move of moves()) {
      order = order.filter((id) => id !== move.tabId)
      order.splice(move.index, 0, move.tabId)
    }
    expect(order).toEqual(['tab-c', 'tab-b', 'tab-a'])
  })

  it('sends nothing for an order the caller already had main make', () => {
    const store = seeded([tab('tab-a'), tab('tab-b')])

    store.getState().reorderUnifiedTabs(GROUP, ['tab-b', 'tab-a'], { layoutOwnerHandled: true })

    expect(moves()).toEqual([])
    expect(store.getState().groupsByWorktree[WT]![0]!.tabOrder).toEqual(['tab-b', 'tab-a'])
  })

  it('records a reopened tab where the window shows it, even when no reorder was needed', () => {
    const store = seeded([tab('tab-a'), tab('tab-b')])

    restoreRecentlyClosedTabPosition(store.getState, WT, 'tab-b', { groupId: GROUP })

    expect(moves()).toEqual([
      { worktreeId: WT, type: 'moveTab', tabId: 'tab-b', toGroupId: GROUP, index: 1 }
    ])
  })

  it('records a reopened tab moved to its old slot once', () => {
    const store = seeded([tab('tab-a'), tab('tab-b'), tab('tab-c')])

    restoreRecentlyClosedTabPosition(store.getState, WT, 'tab-c', { groupId: GROUP, groupIndex: 0 })

    expect(moves()).toEqual([
      { worktreeId: WT, type: 'moveTab', tabId: 'tab-c', toGroupId: GROUP, index: 0 }
    ])
  })
})
