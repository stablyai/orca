// Real-store coverage: which plain new-tab launches start through the host's agent.launch.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../shared/constants'
import { createTestStore, makeWorktree, seedStore } from '../store/slices/store-test-helpers'
import { createStoreCascadesMockApi } from '../store/slices/store-cascades-test-harness'
import { RuntimeRpcCallError } from '@/runtime/runtime-rpc-result'
import { toast } from 'sonner'
import { releaseAgentLaunchPaneSpawn } from './agent-launch-pane-spawn-hold'
import { applyAgentLaunchPaneVerdict } from './agent-launch-pane-verdict-application'
import { AGENT_LAUNCH_NOTHING_RAN_DATA } from '../../../shared/agent-launch-nothing-ran'

const storeBox = vi.hoisted(() => {
  const box: { store: unknown } = { store: null }
  return box
})
vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn(), message: vi.fn() }
}))
vi.mock('@/store', () => ({
  get useAppStore() {
    return storeBox.store
  }
}))
const callRuntimeRpc = vi.hoisted(() =>
  vi.fn<(target: unknown, method: string, params: Record<string, unknown>) => Promise<unknown>>()
)
vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  callRuntimeRpc
}))
const focusTerminalTabSurface = vi.hoisted(() => vi.fn())
vi.mock('@/lib/focus-terminal-tab-surface', () => ({ focusTerminalTabSurface }))
vi.mock('@/lib/launch-agent-tab-prompt-paste', () => ({
  pasteAgentLaunchPromptOnceReady: vi.fn(async () => ({ delivered: false, failureNotified: false }))
}))

createStoreCascadesMockApi()

const WT = 'repo1::/path/wt1'

type Settings = Partial<ReturnType<typeof getDefaultSettings>>

function seed(settings: Settings = {}) {
  const store = createTestStore()
  storeBox.store = store
  seedStore(store, {
    settings: { ...getDefaultSettings('/tmp'), ...settings },
    worktreesByRepo: { repo1: [makeWorktree({ id: WT, repoId: 'repo1', path: '/path/wt1' })] },
    activeWorktreeId: WT
  })
  return store
}

function launchCalls() {
  return callRuntimeRpc.mock.calls.filter(([, method]) => method === 'agent.launchReplay')
}

beforeEach(() => {
  vi.clearAllMocks()
  callRuntimeRpc.mockReturnValue(new Promise(() => {}))
})

describe('a plain new-tab launch', () => {
  it('starts through the host with no prompt and queues no startup command of its own', async () => {
    const store = seed()
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    const result = launchAgentInNewTab({
      requestId: 'request-1',
      agent: 'claude',
      worktreeId: WT,
      freshNewTab: true
    })

    const tabId = result?.surface.kind === 'local-terminal' ? result.surface.tabId : ''
    expect(launchCalls()).toHaveLength(1)
    expect(launchCalls()[0]?.[2]).toMatchObject({
      agent: 'claude',
      target: { kind: 'existing', worktree: `id:${WT}` },
      launchSource: 'tab_bar_quick_launch',
      presentation: 'focused'
    })
    expect(launchCalls()[0]?.[2]).not.toHaveProperty('prompt')
    expect(store.getState().pendingStartupByTabId[tabId]).toBeUndefined()
    expect(store.getState().activeTabId).toBe(tabId)
  })

  const kept: [string, { prompt?: string; freshNewTab?: true }, Settings][] = [
    ['a prompt', { prompt: 'fix it' }, {}],
    ['no opt-in', { freshNewTab: undefined }, {}],
    ['a disabled agent', {}, { disabledTuiAgents: ['claude'] }],
    ['the chat default on', {}, { experimentalNativeChat: true }]
  ]
  it.each(kept)('keeps main launch with %s', async (_label, extra, settings) => {
    const store = seed(settings)
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    launchAgentInNewTab({
      requestId: 'request-2',
      agent: 'claude',
      worktreeId: WT,
      freshNewTab: true,
      ...extra
    })

    expect(launchCalls()).toHaveLength(0)
    if (!('experimentalNativeChat' in settings)) {
      expect(Object.keys(store.getState().pendingStartupByTabId)).toHaveLength(1)
    }
  })
})

function rpcError(code: string, data?: unknown): RuntimeRpcCallError {
  return new RuntimeRpcCallError({
    id: 'desktop-ipc',
    ok: false,
    error: { code, message: code, ...(data ? { data } : {}) },
    _meta: { runtimeId: 'runtime-1' }
  })
}

/** What the host answers for a launch whose record would not open: its error, and that nothing ran. */
function nothingRan(): RuntimeRpcCallError {
  return rpcError('runtime_error', AGENT_LAUNCH_NOTHING_RAN_DATA)
}

function deferred() {
  let reject!: (error: unknown) => void
  const promise = new Promise<unknown>((_resolve, fail) => (reject = fail))
  return { promise, reject }
}

function worktreeTabs(store: ReturnType<typeof seed>) {
  return store.getState().tabsByWorktree[WT] ?? []
}

/** What the host does first when it shows the tab: it takes the pane. */
function hostTakesPane(store: ReturnType<typeof seed>, tabId: string): void {
  releaseAgentLaunchPaneSpawn(tabId, launchLeafId(store, tabId))
}

function launchLeafId(store: ReturnType<typeof seed>, tabId: string): string {
  return worktreeTabs(store).find((tab) => tab.id === tabId)?.agentLaunchPane?.leafId ?? ''
}

async function launchFresh(extra: { activate?: false } = {}) {
  const reply = deferred()
  callRuntimeRpc.mockReturnValue(reply.promise)
  const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')
  const result = launchAgentInNewTab({
    requestId: 'request-3',
    agent: 'claude',
    worktreeId: WT,
    freshNewTab: true,
    ...extra
  })
  const tabId = result?.surface.kind === 'local-terminal' ? result.surface.tabId : ''
  return { tabId, reply }
}

/** Main's own launch of the pick: a tab of the window's that queued the agent's command. */
function windowLaunchedTabs(store: ReturnType<typeof seed>) {
  return worktreeTabs(store).filter((tab) => store.getState().pendingStartupByTabId[tab.id])
}

describe('a plain new-tab launch the host proves ran nothing', () => {
  // Why: before the host route, "+" never touched the launch record, so the agent still started.
  // A failure before the spawn left (its tab still shown) ends the same way.
  it.each([
    ['the host took the pane, its tab still shown', true, false],
    ['the host took the pane and already took its tab back', true, true],
    ['the host never took the pane', false, false]
  ])('starts once as main does: %s', async (_label, tookPane, tabTakenBack) => {
    const store = seed()
    const { tabId, reply } = await launchFresh()
    if (tookPane) {
      hostTakesPane(store, tabId)
    }
    if (tabTakenBack) {
      const leafId = launchLeafId(store, tabId)
      applyAgentLaunchPaneVerdict({ worktreeId: WT, tabId, leafId, verdict: { kind: 'withdrawn' } })
    }

    reply.reject(nothingRan())

    await vi.waitFor(() => expect(windowLaunchedTabs(store)).toHaveLength(1))
    const replacement = windowLaunchedTabs(store)[0]!
    expect(worktreeTabs(store).map((tab) => tab.id)).toEqual([replacement.id])
    expect(store.getState().pendingStartupByTabId[replacement.id]?.launchAgent).toBe('claude')
    expect(launchCalls()).toHaveLength(1)
    // Its workspace had no other tab: taking the host's back must not leave the workspace.
    expect(store.getState().activeWorktreeId).toBe(WT)
    expect(store.getState().activeTabId).toBe(replacement.id)
    expect(focusTerminalTabSurface).toHaveBeenCalledExactlyOnceWith(replacement.id)
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('selects the replacement in the floating panel, as the panel selected the tab it was handed', async () => {
    const store = seed()
    const { tabId, reply } = await launchFresh({ activate: false })
    hostTakesPane(store, tabId)

    reply.reject(nothingRan())

    await vi.waitFor(() => expect(windowLaunchedTabs(store)).toHaveLength(1))
    const replacement = windowLaunchedTabs(store)[0]!
    const group = store
      .getState()
      .groupsByWorktree[WT]?.find((candidate) => candidate.tabOrder.includes(replacement.id))
    expect(group?.activeTabId).toBe(replacement.id)
  })

  it.each([
    ['before the host took it', false],
    ['after the host took it', true]
  ])('never starts a tab the user closed %s', async (_label, tookPane) => {
    const store = seed()
    const { tabId, reply } = await launchFresh()
    if (tookPane) {
      hostTakesPane(store, tabId)
    }
    store.getState().closeTab(tabId, { recordInteraction: false })

    reply.reject(nothingRan())

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(worktreeTabs(store)).toHaveLength(0)
    expect(toast.error).not.toHaveBeenCalled()
  })

  // Why: an unconfirmed launch may be running; a second agent is worse than the notice.
  it.each([
    ['unconfirmed, before the host took the pane', false],
    ['unconfirmed, after the host took the pane', true]
  ])('never starts again when %s', async (_label, tookPane) => {
    const store = seed()
    const { tabId, reply } = await launchFresh()
    if (tookPane) {
      hostTakesPane(store, tabId)
    }

    reply.reject(rpcError('agent_session_operation_unknown'))

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(windowLaunchedTabs(store)).toHaveLength(0)
    expect(launchCalls()).toHaveLength(1)
    if (!tookPane) {
      expect(toast.error).toHaveBeenCalledOnce()
    }
  })

  it('leaves an AI button launch refused, as main does', async () => {
    const store = seed()
    const reply = deferred()
    callRuntimeRpc.mockReturnValue(reply.promise)
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')
    launchAgentInNewTab({
      requestId: 'request-4',
      agent: 'claude',
      worktreeId: WT,
      prompt: 'fix the failing checks',
      promptDelivery: 'submit-after-ready'
    })
    expect(launchCalls()).toHaveLength(1)

    reply.reject(nothingRan())

    await vi.waitFor(() => expect(toast.error).toHaveBeenCalledOnce())
    expect(worktreeTabs(store)).toHaveLength(0)
    expect(launchCalls()).toHaveLength(1)
  })
})
