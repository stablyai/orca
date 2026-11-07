import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { sendLayoutCommandToOwner } from '@/runtime/workspace-layout/commands/layout-owner-command'
import { createTabsSliceMockApi } from '@/store/slices/tabs/tabs-slice-test-harness'
import {
  beginLayoutFramePositions,
  endLayoutFramePositions
} from '@/runtime/workspace-layout/frames/layout-frame-position'
import { createTestStore, seedStore } from '@/store/testing/app-store-test-fixture'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import { dropTabThroughLayoutOwner } from './tab-group-layout-owner-commands'
import { LOCAL_LAYOUT_APPLY_ORIGIN } from '@/runtime/workspace-layout/server/server-layout-apply-routes'

const mocks = vi.hoisted(
  (): {
    send: ReturnType<typeof vi.fn<typeof sendLayoutCommandToOwner>>
    store: ReturnType<typeof createTestStore> | null
  } => ({ send: vi.fn<typeof sendLayoutCommandToOwner>(), store: null })
)

// The store's split takes main's group id only in a layout-owner build.
vi.mock('../../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))
vi.mock('@/runtime/workspace-layout/commands/layout-owner-command', () => ({
  sendLayoutCommandToOwner: mocks.send
}))
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
afterEach(() => endLayoutFramePositions())

describe('dropTabThroughLayoutOwner', () => {
  it('selects nothing on main’s answer: the frame that shows the move selects the tab (L120)', () => {
    const { left, right } = seeded()
    beginLayoutFramePositions()
    dropTabThroughLayoutOwner(WT, { kind: 'move', tabId: 'a', groupId: right })
    // Main's frame lands first (drawn here without frame sync); the user selects meanwhile.
    store().getState().dropUnifiedTab('a', { groupId: right, index: 1 })
    store().getState().focusGroup(WT, left)

    lastHandlers().apply({}, LOCAL_LAYOUT_APPLY_ORIGIN)

    expect(orderOf(right)).toEqual(['c', 'a'])
    expect(store().getState().activeGroupIdByWorktree[WT]).toBe(left)
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
})
