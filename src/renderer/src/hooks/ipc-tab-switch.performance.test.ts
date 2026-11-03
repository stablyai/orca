// @vitest-environment happy-dom

import { describe, expect, it, vi } from 'vitest'
import {
  createTestStore,
  makeTab,
  makeTabGroup,
  makeUnifiedTab
} from '../store/slices/store-test-helpers'
import { buildActiveSurfacePatch } from '../store/slices/tabs/tabs-surface'

const mocks = vi.hoisted(() => ({ getState: vi.fn(), activateOwner: vi.fn() }))
vi.mock('../store', () => ({ useAppStore: { getState: mocks.getState } }))
vi.mock('@/lib/cycled-tab-owner-activation', () => ({
  activateCycledTabOnOwner: mocks.activateOwner
}))

import { handleSwitchTerminalTab } from './ipc-tab-switch'

const WORKTREE_ID = 'cycle-performance'
const GROUP_ID = 'group'

function measureCycle(size: number, fallback: boolean): { visits: number; publications: number } {
  const store = createTestStore()
  const terminals = Array.from({ length: size }, (_, index) =>
    makeTab({ id: `terminal-${index}`, worktreeId: WORKTREE_ID })
  )
  const terminalRows = terminals.map((tab, index) =>
    makeUnifiedTab({
      id: `tab-${index}`,
      entityId: tab.id,
      worktreeId: WORKTREE_ID,
      groupId: GROUP_ID
    })
  )
  const chat = makeUnifiedTab({
    id: 'chat',
    entityId: 'session',
    contentType: 'agent-session',
    worktreeId: WORKTREE_ID,
    groupId: GROUP_ID
  })
  const rows = fallback
    ? [terminalRows[0], chat]
    : [terminalRows[0], chat, ...terminalRows.slice(1)]
  const group = makeTabGroup({
    id: GROUP_ID,
    worktreeId: WORKTREE_ID,
    activeTabId: fallback ? chat.id : terminalRows.at(-1)!.id,
    tabOrder: rows.map((tab) => tab.id)
  })
  store.setState({
    activeWorktreeId: WORKTREE_ID,
    activeGroupIdByWorktree: { [WORKTREE_ID]: GROUP_ID },
    groupsByWorktree: { [WORKTREE_ID]: [group] },
    tabsByWorktree: { [WORKTREE_ID]: terminals },
    unifiedTabsByWorktree: { [WORKTREE_ID]: rows }
  })
  store.setState(buildActiveSurfacePatch(store.getState(), WORKTREE_ID))
  mocks.getState.mockImplementation(store.getState)
  mocks.activateOwner.mockClear()
  const activateTab = vi.spyOn(store.getState(), 'activateTab')
  let visits = 0
  let publications = 0
  const instrument = (): void => {
    const state = store.getState()
    for (const items of [
      state.tabsByWorktree[WORKTREE_ID],
      state.unifiedTabsByWorktree[WORKTREE_ID],
      state.groupsByWorktree[WORKTREE_ID]
    ]) {
      for (const item of items) {
        if (Object.getOwnPropertyDescriptor(item, 'id')?.get) {
          continue
        }
        const id = item.id
        Object.defineProperty(item, 'id', {
          configurable: true,
          enumerable: true,
          get: () => {
            visits += 1
            return id
          }
        })
      }
    }
  }
  instrument()
  const unsubscribe = store.subscribe(() => {
    publications += 1
    instrument()
  })
  try {
    expect(handleSwitchTerminalTab(1)).toBe(true)
    expect(store.getState().activeTabId).toBe(fallback ? 'terminal-1' : 'terminal-0')
    expect(activateTab).toHaveBeenCalledTimes(fallback ? 0 : 2)
    expect(mocks.activateOwner).toHaveBeenCalledTimes(1)
    return { visits, publications }
  } finally {
    unsubscribe()
    activateTab.mockRestore()
  }
}

describe.each([false, true])('terminal shortcut operation bounds (fallback=%s)', (fallback) => {
  it('keeps collection visits linear and activation publications bounded at N and 10N', () => {
    const small = measureCycle(20, fallback)
    const large = measureCycle(200, fallback)
    expect(small.visits).toBeGreaterThan(20)
    expect(large.visits).toBeLessThanOrEqual(small.visits * 10 + 100)
    expect(small.publications).toBeLessThanOrEqual(4)
    expect(large.publications).toBe(small.publications)
  })
})
