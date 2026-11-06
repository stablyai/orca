import { beforeEach, expect, it, vi } from 'vitest'
import { makeTab, makeUnifiedTab } from './store-session-test-harness'
import { makeWorktree } from './worktrees-slice-test-fixtures'
import { makeDetectedResult, qualifyDetectedResult } from './worktrees-detected-listing-fixtures'
import {
  createTestStore,
  mockApi,
  resetRemoteRuntimeMocks,
  resetWorktreeSliceModuleMemory
} from './worktrees-slice-test-harness'

vi.mock('sonner', () => ({
  toast: { warning: vi.fn(), info: vi.fn(), success: vi.fn(), error: vi.fn(), dismiss: vi.fn() }
}))

beforeEach(() => {
  resetWorktreeSliceModuleMemory()
  vi.clearAllMocks()
  resetRemoteRuntimeMocks()
})

const MOVED = 'moved::\\\\wsl.localhost\\Ubuntu\\home\\dev\\moved'
const repoA = { id: 'repoA', path: '/repos/a', displayName: 'a', badgeColor: '#000', addedAt: 0 }

it("keeps a moved project's chat workspace through the startup purge, and purges a stale one", async () => {
  const store = createTestStore()
  const wtA = makeWorktree({ id: 'repoA::/a/wt1', repoId: 'repoA', path: '/a/wt1' })
  mockApi.worktrees.listDetected.mockImplementation(async (args) =>
    qualifyDetectedResult(args, makeDetectedResult('repoA', [wtA]))
  )
  const chat = makeUnifiedTab({
    id: 'structured-agent-session-chat-1',
    worktreeId: MOVED,
    groupId: 'group-1',
    contentType: 'agent-session'
  })
  store.setState({
    repos: [repoA],
    wslMovedProjects: [
      { kind: 'repo', id: 'moved', displayName: 'Moved', path: '/moved', distro: 'Ubuntu' }
    ],
    // A reconciliation can leave an empty terminal entry beside the chat-only workspace.
    tabsByWorktree: {
      [wtA.id]: [makeTab({ id: 'tab-A', worktreeId: wtA.id })],
      [MOVED]: [],
      'repoA::/a/zombie': [makeTab({ id: 'tab-zombie', worktreeId: 'repoA::/a/zombie' })]
    },
    unifiedTabsByWorktree: { [MOVED]: [chat] }
  })

  await store.getState().fetchAllWorktrees()

  expect(store.getState().hasHydratedWorktreePurge).toBe(true)
  expect(Object.keys(store.getState().tabsByWorktree).sort()).toEqual([MOVED, wtA.id].sort())
  expect(store.getState().unifiedTabsByWorktree[MOVED]).toEqual([chat])
})
