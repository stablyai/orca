import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { recordLayoutApply, sendLayoutApply } from '@/runtime/layout-apply-send'

import type { Tab } from '../../../../../shared/tab-types'

import { createTestStore } from '../store-test-helpers'
import { createTabsSliceMockApi } from '../tabs-slice-test-harness'

const mocks = vi.hoisted(() => {
  const held: {
    send: ReturnType<typeof vi.fn<typeof recordLayoutApply>>
    sendFirst: ReturnType<typeof vi.fn<typeof sendLayoutApply>>
    store: unknown
  } = {
    send: vi.fn<typeof recordLayoutApply>(),
    sendFirst: vi.fn<typeof sendLayoutApply>(() => true),
    store: null
  }
  return held
})

vi.mock('../../../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))
vi.mock('@/runtime/layout-apply-send', () => ({
  recordLayoutApply: mocks.send,
  sendLayoutApply: mocks.sendFirst
}))
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
  mocks.sendFirst.mockClear()
})

describe('tab activation in a layout-owner build', () => {
  it('asks main to end a preview, writing no preview flag itself', () => {
    const store = seeded([tab('tab-a'), tab('tab-b', { isPreview: true })])

    store.getState().activateTab('tab-a')
    store.getState().activateTab('tab-b')

    const [a, b] = store.getState().unifiedTabsByWorktree[WT]!
    expect(a).not.toHaveProperty('isPreview')
    // Main's frame ends it (editor-tab-layout-owner.test.ts, "clears a promoted preview").
    expect(b?.isPreview).toBe(true)
    expect(
      mocks.sendFirst.mock.calls.map(([, worktreeId, command]) => [worktreeId, command])
    ).toEqual([[WT, { type: 'promotePreviewTab', tabId: 'tab-b' }]])
  })
})

describe('tab order in a layout-owner build', () => {
  it('records a reversed order as moves main replays to the same order', () => {
    const store = seeded([tab('tab-a'), tab('tab-b'), tab('tab-c')])

    store.getState().reorderUnifiedTabs(GROUP, ['tab-c', 'tab-b', 'tab-a'])

    let order = ['tab-a', 'tab-b', 'tab-c']
    for (const move of moves()) {
      order = order.filter((id) => id !== move.tabId)
      order.splice(move.index, 0, move.tabId)
      // Each step's anchor is the tab its slot follows in the wanted order.
      expect(move.afterTabId).toBe(order[move.index - 1] ?? null)
    }
    expect(order).toEqual(['tab-c', 'tab-b', 'tab-a'])
  })

  it('sends nothing for an order the caller already had main make', () => {
    const store = seeded([tab('tab-a'), tab('tab-b')])

    store.getState().reorderUnifiedTabs(GROUP, ['tab-b', 'tab-a'], { layoutOwnerHandled: true })

    expect(moves()).toEqual([])
    expect(store.getState().groupsByWorktree[WT]![0]!.tabOrder).toEqual(['tab-b', 'tab-a'])
  })
})
