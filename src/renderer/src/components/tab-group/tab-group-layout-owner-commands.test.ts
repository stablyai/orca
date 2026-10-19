import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { sendLayoutCommandToOwner } from '@/runtime/layout-owner-command'
import { createTabsSliceMockApi } from '@/store/slices/tabs-slice-test-harness'
import { beginLayoutFramePositions, endLayoutFramePositions } from '@/runtime/layout-frame-position'
import { createTestStore, makeWorktree, seedStore } from '@/store/slices/store-test-helpers'
import {
  dropTabThroughLayoutOwner,
  setGroupRatioThroughLayoutOwner
} from './tab-group-layout-owner-commands'

const mocks = vi.hoisted(
  (): {
    send: ReturnType<typeof vi.fn<typeof sendLayoutCommandToOwner>>
    store: ReturnType<typeof createTestStore> | null
  } => ({ send: vi.fn<typeof sendLayoutCommandToOwner>(), store: null })
)

// The store's split takes main's group id only in a layout-owner build.
vi.mock('../../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))
vi.mock('@/runtime/layout-owner-command', () => ({ sendLayoutCommandToOwner: mocks.send }))
vi.mock('@/store', () => ({
  get useAppStore() {
    return mocks.store
  }
}))
vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))

createTabsSliceMockApi()

const WT = 'repo1::/path/wt1'

function store() {
  return mocks.store!
}

function seeded(): { left: string; right: string } {
  mocks.store = createTestStore()
  seedStore(store(), {
    activeWorktreeId: WT,
    worktreesByRepo: { repo1: [makeWorktree({ id: WT, repoId: 'repo1', path: '/path/wt1' })] }
  })
  for (const id of ['a', 'b', 'c']) {
    store().getState().createTab(WT, undefined, undefined, { id })
  }
  const left = store().getState().groupsByWorktree[WT]![0]!.id
  store().getState().dropUnifiedTab('c', { groupId: left, splitDirection: 'right' })
  const right = store()
    .getState()
    .groupsByWorktree[WT]!.find((g) => g.id !== left)!.id
  store().getState().activateTab('a')
  return { left, right }
}

const groupOf = (tabId: string) =>
  store()
    .getState()
    .unifiedTabsByWorktree[WT]!.find((tab) => tab.id === tabId)?.groupId
const orderOf = (groupId: string) =>
  store()
    .getState()
    .groupsByWorktree[WT]!.find((group) => group.id === groupId)?.tabOrder
const lastHandlers = () => mocks.send.mock.calls.at(-1)![2]

beforeEach(() => {
  mocks.send.mockReset()
  mocks.send.mockReturnValue(true)
})

describe('dropTabThroughLayoutOwner', () => {
  it('moves the tab only once main has, then selects it in its new group', () => {
    const { right } = seeded()
    expect(
      dropTabThroughLayoutOwner(WT, { kind: 'move', tabId: 'a', groupId: right, index: 0 })
    ).toBe(true)
    expect(mocks.send).toHaveBeenCalledWith(
      WT,
      { type: 'moveTab', tabId: 'a', toGroupId: right, index: 0 },
      expect.anything()
    )
    expect(groupOf('a')).not.toBe(right)

    lastHandlers().apply({})

    expect(orderOf(right)).toEqual(['a', 'c'])
    expect(store().getState().activeGroupIdByWorktree[WT]).toBe(right)
  })

  it('only selects the tab when main’s frame already moved it', () => {
    const { left, right } = seeded()
    dropTabThroughLayoutOwner(WT, { kind: 'move', tabId: 'a', groupId: right })
    // Main's frame lands first: the tab is in its group, the window's selection unchanged.
    store().getState().dropUnifiedTab('a', { groupId: right, index: 1 })
    store().getState().focusGroup(WT, left)

    lastHandlers().apply({})

    expect(orderOf(right)).toEqual(['c', 'a'])
    expect(store().getState().activeGroupIdByWorktree[WT]).toBe(right)
    expect(
      store()
        .getState()
        .groupsByWorktree[WT]!.find((g) => g.id === right)?.activeTabId
    ).toBe('a')
  })

  it('splits off a group under main’s id when the window makes the move itself', () => {
    const { left } = seeded()

    dropTabThroughLayoutOwner(WT, { kind: 'split', tabId: 'b', groupId: left, direction: 'down' })
    expect(mocks.send.mock.calls[0]![1]).toEqual({
      type: 'splitGroup',
      tabId: 'b',
      besideGroupId: left,
      direction: 'down'
    })
    lastHandlers().apply({ groupId: 'group-main' })

    expect(groupOf('b')).toBe('group-main')
    expect(store().getState().activeGroupIdByWorktree[WT]).toBe('group-main')
  })

  it('moves a lone tab’s group whole when main kept its id', () => {
    const { left, right } = seeded()

    dropTabThroughLayoutOwner(WT, { kind: 'split', tabId: 'c', groupId: left, direction: 'left' })
    lastHandlers().apply({ groupId: right })

    expect(
      store()
        .getState()
        .groupsByWorktree[WT]!.map((group) => group.id)
    ).toEqual([left, right])
    expect(store().getState().layoutByWorktree[WT]).toEqual({
      type: 'split',
      direction: 'horizontal',
      first: { type: 'leaf', groupId: right },
      second: { type: 'leaf', groupId: left },
      ratio: 0.5
    })
    expect(store().getState().activeGroupIdByWorktree[WT]).toBe(right)
  })

  it('leaves placing a lone tab’s group to main’s frame while frames flow', () => {
    const { left, right } = seeded()
    const layout = store().getState().layoutByWorktree[WT]
    beginLayoutFramePositions()
    try {
      dropTabThroughLayoutOwner(WT, { kind: 'split', tabId: 'c', groupId: left, direction: 'left' })
      lastHandlers().apply({ groupId: right })
    } finally {
      endLayoutFramePositions()
    }

    expect(store().getState().layoutByWorktree[WT]).toBe(layout)
    expect(store().getState().activeGroupIdByWorktree[WT]).toBe(right)
  })

  it('leaves a drop the window would skip to today’s path, sending nothing', () => {
    const { left, right } = seeded()

    expect(
      dropTabThroughLayoutOwner(WT, {
        kind: 'split',
        tabId: 'c',
        groupId: left,
        direction: 'right'
      })
    ).toBe(false)
    expect(mocks.send).not.toHaveBeenCalled()
    expect(groupOf('c')).toBe(right)
  })

  it('leaves a move into the tab’s own group to today’s no-op, sending nothing', () => {
    const { left } = seeded()
    const before = orderOf(left)

    expect(
      dropTabThroughLayoutOwner(WT, { kind: 'move', tabId: 'a', groupId: left, index: 1 })
    ).toBe(false)
    expect(mocks.send).not.toHaveBeenCalled()
    expect(orderOf(left)).toEqual(before)
  })

  it('reorders within a group at the index main got', () => {
    const { left } = seeded()

    dropTabThroughLayoutOwner(WT, {
      kind: 'reorder',
      tabId: 'a',
      groupId: left,
      tabOrder: ['b', 'a']
    })
    expect(mocks.send.mock.calls[0]![1]).toEqual({
      type: 'moveTab',
      tabId: 'a',
      toGroupId: left,
      index: 1
    })
    lastHandlers().apply({})

    expect(orderOf(left)).toEqual(['b', 'a'])
  })

  it('moves as today when main cannot act, and not at all when main refuses', () => {
    const { right } = seeded()

    dropTabThroughLayoutOwner(WT, { kind: 'move', tabId: 'a', groupId: right })
    lastHandlers().refused?.('invalid_params')
    expect(groupOf('a')).not.toBe(right)

    dropTabThroughLayoutOwner(WT, { kind: 'move', tabId: 'a', groupId: right })
    lastHandlers().asToday()
    expect(orderOf(right)).toEqual(['c', 'a'])
  })

  it('splits as today when main moved a group whole that holds more tabs here', () => {
    const { left } = seeded()

    dropTabThroughLayoutOwner(WT, { kind: 'split', tabId: 'b', groupId: left, direction: 'down' })
    // Main had only `b` in that group, so it kept the group's id and moved it.
    lastHandlers().apply({ groupId: left })

    expect(orderOf(left)).toEqual(['a'])
    expect(groupOf('b')).not.toBe(left)
  })
})

describe('setGroupRatioThroughLayoutOwner', () => {
  it('sets the ratio here, then has main save the group tree', () => {
    seeded()

    setGroupRatioThroughLayoutOwner(WT, '', 0.3)

    const groupLayout = store().getState().layoutByWorktree[WT]
    expect(groupLayout).toMatchObject({ type: 'split', ratio: 0.3 })
    expect(mocks.send).toHaveBeenCalledWith(
      WT,
      { type: 'setGroupRatios', groupLayout },
      expect.anything()
    )
  })

  it('sends nothing for an unchanged ratio', () => {
    seeded()

    setGroupRatioThroughLayoutOwner(WT, '', 0.5)

    expect(mocks.send).not.toHaveBeenCalled()
  })
})
