import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import { installActiveWorktreeRemovalSuccessor } from '@/lib/active-worktree-removal-successor'
import { createTestStore, makeWorktree, seedStore, TEST_REPO } from './store-test-helpers'
import { createStoreCascadesMockApi } from './store-cascades-test-harness'
import { clearSshHostWorkspaces } from '@/components/sidebar/ssh-host-remove-workspaces'

const storeAccess = vi.hoisted(() => ({ getState: vi.fn() }))
vi.mock('@/store', () => ({ useAppStore: storeAccess }))

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))
vi.mock('@/components/terminal-pane/pty-dispatcher', () => ({
  restorePtyDataHandlersAfterFailedShutdown: vi.fn(),
  unregisterPtyDataHandlers: vi.fn(() => [])
}))
vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return { ...actual, detectAgentStatusFromTitle: vi.fn().mockReturnValue(null) }
})
vi.mock('@/lib/worktree-activation', () => ({ activateAndRevealWorktree: vi.fn() }))

import { activateAndRevealWorktree } from '@/lib/worktree-activation'

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

afterEach(() => {
  dispose?.()
  dispose = null
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
  workspaceCount: 1,
  isConnected: false
}

describe('deleting the active workspace', () => {
  it('hands off from a browser-only workspace after returning from Settings', async () => {
    const store = setup()
    store.getState().createBrowserTab(active.id, 'https://example.com')
    store.getState().openSettingsPage()
    store.getState().closeSettingsPage()
    expect(await forget(store, active)).toEqual({ ok: true })
    expect(activateAndRevealWorktree).toHaveBeenCalledOnce()
    expect(vi.mocked(activateAndRevealWorktree).mock.calls[0][0]).toBe(sibling.id)
  })

  it('respects a user closing the last browser tab after startup dropped its row', async () => {
    const store = setup()
    const tabId = store.getState().createBrowserTab(active.id, 'https://example.com')
    store.setState({ worktreesByRepo: { repo1: [sibling] } })
    store.getState().closeBrowserTab(tabId.id)
    await Promise.resolve()
    expect(store.getState().activeWorktreeId).toBeNull()
    expect(activateAndRevealWorktree).not.toHaveBeenCalled()
  })

  it('keeps a failed host removal selected and allows a later ordinary removal to hand off', async () => {
    const store = setup()
    forgetLocal.mockImplementationOnce(async () => {
      store.setState({ worktreesByRepo: { ...store.getState().worktreesByRepo } })
      throw new Error('host unavailable')
    })
    removeForHost.mockRejectedValueOnce(new Error('host unavailable'))
    expect((await clearSshHostWorkspaces(resolution, 'forget-local')).failedIds).toContain(
      active.id
    )
    expect(store.getState().activeWorktreeId).toBe(active.id)
    expect(activateAndRevealWorktree).not.toHaveBeenCalled()
    await forget(store, active)
    expect(vi.mocked(activateAndRevealWorktree).mock.calls[0]?.[0]).toBe(sibling.id)
  })

  it('stays on Landing when an SSH host is forgotten after its last PTY exited', async () => {
    const store = setup()
    const tab = store.getState().createTab(active.id)
    store.getState().closeTab(tab.id, { reason: 'pty-exit' })
    expect(store.getState().activeWorktreeId).toBeNull()
    await clearSshHostWorkspaces(resolution, 'forget-local')
    expect(activateAndRevealWorktree).not.toHaveBeenCalled()
  })

  it('keeps paired-host retirement on Landing while ordinary disappearance on another host still repairs', async () => {
    const store = setup()
    const retired = { ...active, runtimeOwnerEnvironmentId: 'retired' }
    store.setState({ worktreesByRepo: { repo1: [retired, sibling, main] } })
    store.getState().purgeStaleRuntimeHostState(['retired'])
    await Promise.resolve()
    expect(activateAndRevealWorktree).not.toHaveBeenCalled()
    store.getState().setActiveWorktree(sibling.id, 'local')
    store.getState().purgeStaleRuntimeHostState(['unrelated'])
    await forget(store, sibling)
    await Promise.resolve()
    expect(vi.mocked(activateAndRevealWorktree).mock.calls[0]?.[0]).toBe(main.id)
  })
})
