import { afterEach, expect, it, vi } from 'vitest'
import { createTestStore, makeWorktree, seedStore } from '../slices/store-test-helpers'
import { createStoreCascadesMockApi } from '../slices/store-cascades-test-harness'
import type {
  EmptyTerminalTabRetirementRequest,
  EmptyTerminalTabRetirementResult
} from '../../../../shared/empty-terminal-tab-retirement'

const WORKTREE = 'repo1::/path/worktree'
const TAB = '11111111-1111-4111-8111-111111111111'
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
function fixture() {
  const api = createStoreCascadesMockApi()
  const retire = vi
    .fn<(args: EmptyTerminalTabRetirementRequest) => Promise<EmptyTerminalTabRetirementResult>>()
    .mockResolvedValue({ closed: true })
  Object.assign(window.api, { session: { retireEmptyTerminalTab: retire } })
  const store = createTestStore()
  seedStore(store, {
    worktreesByRepo: {
      repo1: [makeWorktree({ id: WORKTREE, repoId: 'repo1', path: '/path/worktree' })]
    },
    tabsByWorktree: { [WORKTREE]: [] },
    groupsByWorktree: {},
    unifiedTabsByWorktree: {},
    activeGroupIdByWorktree: {}
  })
  return { api, store, retire }
}

it('requests captured empty identity only for an explicit user close', () => {
  const f = fixture()
  const tab = f.store
    .getState()
    .createTab(WORKTREE, undefined, undefined, { id: TAB, activate: false })
  f.store.getState().closeTab(TAB)
  expect(f.retire).toHaveBeenCalledWith({
    worktreeId: WORKTREE,
    tabId: TAB,
    createdAt: tab.createdAt,
    generation: 0
  })
  const automatic = f.store
    .getState()
    .createTab(WORKTREE, undefined, undefined, { activate: false })
  f.store.getState().closeTab(automatic.id, { reason: 'cleanup' })
  expect(f.retire).toHaveBeenCalledTimes(1)
  expect(f.api.pty.kill).not.toHaveBeenCalled()
})

it('same-clock hinted adoption creates bound ownership instead of another empty request', () => {
  vi.spyOn(Date, 'now').mockReturnValue(1000)
  const f = fixture()
  const old = f.store
    .getState()
    .createTab(WORKTREE, undefined, undefined, { id: TAB, activate: false })
  f.store.getState().closeTab(TAB)
  const replacement = f.store.getState().createTab(WORKTREE, undefined, undefined, {
    id: TAB,
    initialPtyId: 'host-adopted',
    activate: false
  })
  expect(replacement.id).toBe(old.id)
  expect(replacement.createdAt).toBe(old.createdAt)
  expect(f.store.getState().terminalLayoutsByTabId[TAB].root).not.toBeNull()
  f.store.getState().closeTab(TAB)
  expect(f.retire).toHaveBeenCalledTimes(1)
})

it('ordinary reopen mints another identity even within the same clock tick', () => {
  vi.spyOn(Date, 'now').mockReturnValue(1000)
  const f = fixture()
  f.store.getState().createTab(WORKTREE, undefined, undefined, { id: TAB, activate: false })
  f.store.getState().closeTab(TAB)
  expect(f.store.getState().reopenClosedTerminalTab(WORKTREE)).toBe(true)
  const reopened = f.store.getState().tabsByWorktree[WORKTREE][0]
  expect(reopened.id).not.toBe(TAB)
  expect(reopened.createdAt).toBe(1000)
  expect(f.retire).toHaveBeenCalledTimes(1)
})

it('an older preload still permits renderer close without a host acknowledgement', () => {
  const f = fixture()
  delete window.api.session.retireEmptyTerminalTab
  f.store.getState().createTab(WORKTREE, undefined, undefined, { id: TAB, activate: false })
  expect(() => f.store.getState().closeTab(TAB)).not.toThrow()
  expect(f.retire).not.toHaveBeenCalled()
})

it('keeps store-only close available without a renderer window', () => {
  const f = fixture()
  f.store.getState().createTab(WORKTREE, undefined, undefined, { id: TAB, activate: false })
  vi.stubGlobal('window', undefined)

  expect(() => f.store.getState().closeTab(TAB)).not.toThrow()
  expect(f.store.getState().tabsByWorktree[WORKTREE]).toEqual([])
  expect(f.retire).not.toHaveBeenCalled()
})
