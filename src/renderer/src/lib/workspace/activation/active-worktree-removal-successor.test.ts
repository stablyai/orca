import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status/aggregation/worktree-agent-status'
import {
  installActiveWorktreeRemovalSuccessor,
  pickActiveWorktreeSuccessor
} from '@/lib/workspace/activation/active-worktree-removal-successor'
import { createTestStore, seedStore } from '../../../store/testing/app-store-test-fixture'
import { makeWorktree } from '../../../store/slices/worktrees/worktree.test-fixture'
import { makeTerminalTab } from '../../../store/terminals/testing/terminal-row.test-fixture'
import { TEST_REPO } from '../../../store/repos/repo.test-fixture'
import { createStoreCascadesMockApi } from '../../../store/testing/app-store-cascade-api.test-fixture'
import { clearSshHostWorkspaces } from '@/components/sidebar/ssh-host-remove-workspaces'
import {
  drawTabsFromMain,
  type TabsDrawnFromMain
} from '../../../store/slices/tabs/tabs-drawn-from-main.test-fixture'

const storeAccess = vi.hoisted(() => ({ getState: vi.fn() }))
vi.mock('@/store/index', () => ({ useAppStore: storeAccess }))

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))
vi.mock('@/components/terminal-pane/pty-transport/delivery/pty-dispatcher', () => ({}))

vi.mock('@/components/terminal-pane/pty-transport/shutdown/pty-shutdown-data-suspension', () => ({
  restorePtyDataHandlersAfterFailedShutdown: vi.fn(),
  unregisterPtyDataHandlers: vi.fn(() => [])
}))
vi.mock('@/lib/agent-status/aggregation/worktree-agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return { ...actual, detectAgentStatusFromTitle: vi.fn().mockReturnValue(null) }
})
vi.mock('@/lib/workspace/activation/worktree-activation', () => ({
  activateAndRevealWorktree: vi.fn()
}))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', async (importOriginal) =>
  (
    await import('@/runtime/workspace-layout/testing/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
)
vi.mock('@/runtime/workspace-layout/frames/runtime-layout-client', async (importOriginal) =>
  (
    await import('@/runtime/workspace-layout/testing/layout-apply-test-transport.test-fixture')
  ).runtimeLayoutClientWithTestFrames(await importOriginal())
)

import { activateAndRevealWorktree } from '@/lib/workspace/activation/worktree-activation'

const mockApi = createStoreCascadesMockApi()
const forgetLocal = vi.fn().mockResolvedValue({})
const removeForHost = vi.fn().mockResolvedValue(undefined)
Object.assign(mockApi.worktrees, { forgetLocal })
Object.assign(mockApi.repos, { removeForHost })
beforeEach(() => {
  vi.mocked(activateAndRevealWorktree).mockReset()
  forgetLocal.mockReset().mockResolvedValue({})
  removeForHost.mockReset().mockResolvedValue(undefined)
})
let dispose: (() => void) | null = null
let layoutMain: TabsDrawnFromMain | undefined

afterEach(() => {
  dispose?.()
  dispose = null
  layoutMain?.close()
  layoutMain = undefined
})

const active = makeWorktree({ id: 'repo1::/active', repoId: 'repo1', hostId: 'ssh:host' })
const sibling = makeWorktree({ id: 'repo1::/sibling', repoId: 'repo1', hostId: 'local' })
const main = { ...sibling, id: 'repo1::/main', isMainWorktree: true }
function setup() {
  const store = createTestStore()
  seedStore(store, {
    repos: [TEST_REPO, { ...TEST_REPO, executionHostId: 'ssh:host', connectionId: 'host' }],
    worktreesByRepo: { repo1: [active, sibling, main] },
    activeWorktreeId: active.id,
    activeWorkspaceExecutionHostId: 'ssh:host',
    activeView: 'terminal'
  })
  storeAccess.getState.mockImplementation(store.getState)
  dispose = installActiveWorktreeRemovalSuccessor(store)
  return store
}
const forget = (store: ReturnType<typeof setup>, worktree: typeof active) =>
  store
    .getState()
    .removeWorktree({ id: worktree.id, executionHostId: worktree.hostId ?? null }, false, {
      mode: 'forget-local'
    })
const resolution = {
  targetId: 'host',
  workspaceWorktreeIds: [active.id],
  hostRepoIds: ['repo1'],
  workspaceCount: 1
}

describe('deleting the active workspace', () => {
  it('respects a user closing the last browser tab after startup dropped its row', async () => {
    const store = setup()
    layoutMain = await drawTabsFromMain(store)
    const tabId = store.getState().createBrowserTab(active.id, 'https://example.com')
    await layoutMain.settle()
    store.setState({ worktreesByRepo: { repo1: [sibling] } })
    store.getState().closeBrowserTab(tabId.id)
    await layoutMain.settle()
    await Promise.resolve()
    expect(store.getState().activeWorktreeId).toBeNull()
  })

  it('keeps a failed host removal selected and allows a later ordinary removal to hand off', async () => {
    const store = setup()
    forgetLocal.mockImplementationOnce(async () => {
      store.setState({ worktreesByRepo: { ...store.getState().worktreesByRepo } })
      throw new Error('host unavailable')
    })
    removeForHost.mockRejectedValueOnce(new Error('host unavailable'))
    expect((await clearSshHostWorkspaces(resolution)).failedIds).toContain(active.id)
    expect(store.getState().activeWorktreeId).toBe(active.id)

    await forget(store, active)
  })
  it('does not wake a sibling that "Hide sleeping" keeps out of the sidebar', async () => {
    const store = setup()
    const awake = { ...sibling, id: 'repo1::/awake' }
    store.setState({
      worktreesByRepo: { repo1: [active, sibling, awake, main] },
      lastVisitedAtByWorktreeId: { [sibling.id]: 2, [awake.id]: 1 },
      // Only the sleeping sweep gates the pick; other filters hide nothing a jump would wake.
      filterRepoIds: ['repo2'],
      showSleepingWorkspaces: false,
      alwaysShowDefaultBranchWorkspace: false,
      persistedUIReady: true,
      workspaceSessionReady: true,
      tabsByWorktree: { [awake.id]: [makeTerminalTab({ id: 'awake-tab', worktreeId: awake.id })] },
      ptyIdsByTabId: { 'awake-tab': ['pty-awake'] }
    })
    await forget(store, active)
    await Promise.resolve()

    store.getState().setActiveWorktree(awake.id, 'local')
    vi.mocked(activateAndRevealWorktree).mockReset()
    store.setState({ ptyIdsByTabId: {} })
    await forget(store, awake)
    await Promise.resolve()

    expect(store.getState().activeWorktreeId).toBeNull()
  })

  it('picks a sibling the sidebar still shows through a PTY-rebind grace window', () => {
    const store = setup()
    store.setState({
      worktreesByRepo: { repo1: [sibling, main] },
      showSleepingWorkspaces: false,
      alwaysShowDefaultBranchWorkspace: false,
      persistedUIReady: true,
      workspaceSessionReady: true,
      tabsByWorktree: { [sibling.id]: [makeTerminalTab({ id: 'rebind', worktreeId: sibling.id })] }
    })
    const removed = { id: active.id, hostId: null, repoId: 'repo1', ownerHostIds: [] }
    expect(pickActiveWorktreeSuccessor(store.getState(), removed, new Set())).toBeNull()
    expect(pickActiveWorktreeSuccessor(store.getState(), removed, new Set([sibling.id]))?.id).toBe(
      sibling.id
    )
  })
})
