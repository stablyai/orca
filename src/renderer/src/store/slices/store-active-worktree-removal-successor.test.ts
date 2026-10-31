import {
  beginDesktopNavigation,
  captureDesktopNavigation,
  navigateDesktopGroup,
  openDesktopWorkbench
} from '@/lib/desktop-navigation-request'
import { runAsAutomaticDeselection } from '@/store/active-worktree-deselection-intent'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import { installActiveWorktreeRemovalSuccessor } from '@/lib/active-worktree-removal-successor'
import { createTestStore, makeWorktree, seedStore, TEST_REPO } from './store-test-helpers'
import { createStoreCascadesMockApi } from './store-cascades-test-harness'
import { clearSshHostWorkspaces } from '@/components/sidebar/ssh-host-remove-workspaces'
import { drawTabsFromMain, type TabsDrawnFromMain } from './tabs-drawn-from-main.test-fixture'

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
vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
)
vi.mock('@/runtime/runtime-layout-client', async (importOriginal) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeLayoutClientWithTestFrames(await importOriginal())
)

import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { publishStructuredSessionSummaries } from '@/components/native-chat/structured-session-summary-store'

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
  openDesktopWorkbench(store.getState(), active.id)
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
  it('hands off from a browser-only workspace after returning from Settings', async () => {
    const store = setup()
    const localActive = { ...active, hostId: 'local' as const }
    store.setState({
      worktreesByRepo: { repo1: [localActive, sibling, main] },
      activeWorkspaceExecutionHostId: 'local'
    })
    layoutMain = await drawTabsFromMain(store)
    store.getState().createBrowserTab(active.id, 'https://example.com')
    await layoutMain.settle()
    store.getState().openSettingsPage()
    store.getState().closeSettingsPage()
    expect(await forget(store, localActive)).toEqual({ ok: true })
    expect(activateAndRevealWorktree).toHaveBeenCalledOnce()
    expect(vi.mocked(activateAndRevealWorktree).mock.calls[0][0]).toBe(sibling.id)
  })

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
    expect(activateAndRevealWorktree).not.toHaveBeenCalled()
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
    expect(activateAndRevealWorktree).not.toHaveBeenCalled()
    await forget(store, active)
    expect(vi.mocked(activateAndRevealWorktree).mock.calls[0]?.[0]).toBe(sibling.id)
  })

  it('stays on Landing when an SSH host is forgotten after its last PTY exited', async () => {
    const store = setup()
    const tab = store.getState().createTab(active.id)
    store.getState().closeTab(tab.id, { reason: 'pty-exit' })
    expect(store.getState().activeWorktreeId).toBeNull()
    await clearSshHostWorkspaces(resolution)
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

it.each(['thread-draft', 'empty-workbench', 'terminal'] as const)(
  'removes the actual row after Settings OFF/Back with retained route=%s',
  async (view) => {
    const store = setup()
    Object.assign(window.api, { ephemeralVm: { listRuntimes: vi.fn().mockResolvedValue([]) } })
    store.setState({
      settings: { ...store.getState().settings!, experimentalThreads: false },
      activeView: view
    })
    store.getState().openSettingsPage()
    store.getState().closeSettingsPage()
    expect(await forget(store, active)).toEqual({ ok: true })
    await Promise.resolve()
    expect(store.getState().activeWorktreeId).toBeNull()
    expect(activateAndRevealWorktree).toHaveBeenCalledExactlyOnceWith(sibling.id, {
      revealInSidebar: false,
      executionHostId: 'local',
      navigation: expect.objectContaining({ experimental: true })
    })
  }
)
it.each(['thread-draft', 'empty-workbench'] as const)(
  'setting-only wake admits the actual removal at unchanged route/W: %s',
  async (view) => {
    const store = setup()
    Object.assign(window.api, { ephemeralVm: { listRuntimes: vi.fn().mockResolvedValue([]) } })
    store.setState({
      activeView: view,
      settings: { ...store.getState().settings!, experimentalThreads: true }
    })
    store.setState({ settings: { ...store.getState().settings!, experimentalThreads: false } })
    expect(await forget(store, active)).toEqual({ ok: true })
    await Promise.resolve()
    expect(vi.mocked(activateAndRevealWorktree).mock.calls[0]?.[0]).toBe(sibling.id)
  }
)
it.each(['empty-workbench', 'newer-draft', 'user-clear'] as const)(
  'queued retirement revalidates current effective context: %s',
  async (input) => {
    const store = setup()
    store.setState({
      activeView: 'empty-workbench',
      settings: { ...store.getState().settings!, experimentalThreads: true }
    })
    const clear = () =>
      store.setState({
        worktreesByRepo: { repo1: [sibling, main] },
        activeWorktreeId: null,
        activeWorkspaceExecutionHostId: null
      })
    if (input === 'user-clear') {
      store.getState().setActiveWorktree(null)
      clear()
    } else {
      runAsAutomaticDeselection(clear)
    }
    if (input === 'newer-draft') {
      beginDesktopNavigation(store.getState(), true)
      store.setState({ activeView: 'thread-draft' })
    }
    await Promise.resolve()
    expect(vi.mocked(activateAndRevealWorktree).mock.calls.length).toBe(
      input === 'empty-workbench' ? 1 : 0
    )
  }
)

import { navigateDesktopTab } from '@/lib/desktop-navigation-request'
import { makeUnifiedTab, makeTabGroup } from '@/store/slices/store-test-helpers'
it.each([
  { path: 'automatic-drop', navigate: true },
  { path: 'actual-forget', navigate: true },
  { path: 'automatic-drop', navigate: false },
  { path: 'actual-forget', navigate: false }
] as const)(
  'ordinary same-W navigation before removal preserves successor: %j',
  async ({ path, navigate }) => {
    const store = setup()
    Object.assign(window.api, { ephemeralVm: { listRuntimes: vi.fn().mockResolvedValue([]) } })
    store.setState({ settings: { ...store.getState().settings!, experimentalThreads: false } })
    const t = makeUnifiedTab({
      id: 'nav-target',
      entityId: 'nav-target',
      worktreeId: active.id,
      groupId: 'nav-g',
      contentType: 'agent-session',
      executionHostId: 'ssh:host'
    })
    const r = { ...t, id: 'before-navigation', entityId: 'before-navigation' }
    store.setState({
      unifiedTabsByWorktree: { [active.id]: [r, t] },
      groupsByWorktree: {
        [active.id]: [
          makeTabGroup({
            id: 'nav-g',
            worktreeId: active.id,
            tabOrder: [r.id, t.id],
            activeTabId: r.id
          })
        ]
      },
      activeGroupIdByWorktree: { [active.id]: 'nav-g' }
    })
    if (navigate) {
      expect(navigateDesktopTab(store.getState(), t.id, { worktreeId: active.id })).toBe(true)
    }
    expect(store.getState().activeWorktreeId).toBe(active.id)
    if (path === 'actual-forget') {
      expect(await forget(store, active)).toEqual({ ok: true })
    } else {
      runAsAutomaticDeselection(() =>
        store.setState({
          worktreesByRepo: { repo1: [sibling, main] },
          activeWorktreeId: null,
          activeWorkspaceExecutionHostId: null
        })
      )
    }
    await Promise.resolve()
    expect(store.getState().activeWorktreeId).toBeNull()
    expect(activateAndRevealWorktree).toHaveBeenCalledOnce()
    expect(vi.mocked(activateAndRevealWorktree).mock.calls[0]?.[0]).toBe(sibling.id)
  }
)

it.each(['already-installed', 'install-while-pending'] as const)(
  'does not adopt an in-flight compose request from catalog writes: %s',
  async (installation) => {
    const store = setup()
    store.setState({ settings: { ...store.getState().settings!, experimentalThreads: true } })
    const projects = await import('@/components/threads/thread-projects')
    const held =
      Promise.withResolvers<Awaited<ReturnType<typeof projects.eligibleThreadProjects>>>()
    const spy = vi.spyOn(projects, 'eligibleThreadProjects').mockReturnValue(held.promise)
    const { openNewThread } = await import('@/components/threads/thread-actions')
    const pending = openNewThread()
    const original = captureDesktopNavigation(store.getState())
    if (installation === 'install-while-pending') {
      dispose?.()
      dispose = installActiveWorktreeRemovalSuccessor(store)
    }
    store.setState({ worktreesByRepo: { ...store.getState().worktreesByRepo } })
    runAsAutomaticDeselection(() =>
      store.setState({
        worktreesByRepo: { repo1: [sibling, main] },
        activeWorktreeId: null,
        activeWorkspaceExecutionHostId: null
      })
    )
    await Promise.resolve()
    expect(activateAndRevealWorktree).not.toHaveBeenCalled()
    held.resolve([{ key: 'eligible-project', repo: TEST_REPO, worktree: sibling, hostId: 'local' }])
    await pending
    expect(store.getState().activeView).toBe('thread-draft')
    expect(captureDesktopNavigation(store.getState()).id).toBe(original.id)
    spy.mockRestore()
  }
)

it.each(['same-id', 'other-group', 'classified'] as const)(
  'committed same-workspace navigation wakes the listed origin: %s',
  async (selection) => {
    const store = setup()
    const tab = makeUnifiedTab({
      id: 'selected',
      worktreeId: active.id,
      groupId: 'g',
      executionHostId: 'ssh:host',
      ...(selection === 'classified' ? { contentType: 'agent-session' as const } : {})
    })
    const other = { ...tab, id: 'other-group', groupId: 'g2' }
    store.setState({
      unifiedTabsByWorktree: { [active.id]: [tab, other] },
      groupsByWorktree: {
        [active.id]: [
          makeTabGroup({ id: 'g', worktreeId: active.id, activeTabId: tab.id, tabOrder: [tab.id] }),
          makeTabGroup({
            id: 'g2',
            worktreeId: active.id,
            activeTabId: other.id,
            tabOrder: [other.id]
          })
        ]
      },
      activeGroupIdByWorktree: { [active.id]: 'g' }
    })
    if (selection === 'classified') {
      store.setState({ settings: { ...store.getState().settings!, experimentalThreads: true } })
      publishStructuredSessionSummaries([
        {
          tabId: tab.id,
          tab,
          summary: {
            sessionId: tab.entityId,
            workspaceId: active.id,
            agent: 'codex',
            status: 'idle',
            surface: 'thread',
            updatedAt: 1
          }
        }
      ])
    }
    if (selection !== 'other-group') {
      navigateDesktopTab(store.getState(), tab.id)
    } else {
      navigateDesktopGroup(store.getState(), active.id, 'g2')
    }
    runAsAutomaticDeselection(() =>
      store.setState({
        worktreesByRepo: { repo1: [sibling, main] },
        activeWorktreeId: null,
        activeWorkspaceExecutionHostId: null
      })
    )
    await Promise.resolve()
    expect(activateAndRevealWorktree).toHaveBeenCalledOnce()
  }
)
