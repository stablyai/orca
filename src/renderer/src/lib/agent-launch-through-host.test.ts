import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import { RuntimeRpcCallError } from '@/runtime/runtime-rpc-result'
import { createTabsSliceMockApi } from '../store/slices/tabs-slice-test-harness'
import { createTestStore } from '../store/slices/store-test-helpers'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/agent-status', async (importOriginal) => ({
  ...(await importOriginal<typeof AgentStatusModule>()),
  detectAgentStatusFromTitle: vi.fn().mockReturnValue(null)
}))

const testStore = vi.hoisted(() => {
  const ref: { current: ReturnType<typeof createTestStore> | null } = { current: null }
  return ref
})
vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => {
      if (!testStore.current) {
        throw new Error('no test store')
      }
      return testStore.current.getState()
    }
  }
}))
const callRuntimeRpc = vi.hoisted(() =>
  vi.fn<(target: unknown, method: string, params: Record<string, unknown>) => Promise<unknown>>()
)
vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  callRuntimeRpc
}))

createTabsSliceMockApi()

const { launchAgentThroughHost } = await import('./agent-launch-through-host')
const { agentLaunchPaneSpawnHold, releaseAgentLaunchPaneSpawn } =
  await import('./agent-launch-pane-spawn-hold')
const { agentLaunchPanePrompt } = await import('./agent-launch-pane-prompt')

const WT = 'repo1::/tmp/feature'
let store: ReturnType<typeof createTestStore>

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function rpcError(code: string): RuntimeRpcCallError {
  return new RuntimeRpcCallError({
    id: 'desktop-ipc',
    ok: false,
    error: { code, message: code },
    _meta: { runtimeId: 'runtime-1' }
  })
}

function terminalResult(paneKey: string) {
  return {
    outcome: { kind: 'terminal', handle: 'term_1', paneKey },
    worktreeId: WT,
    receipt: { mode: 'terminal', preferred: 'terminal', reason: 'user_default', detail: 'x' }
  }
}

function launchTab(tabId: string) {
  return store.getState().tabsByWorktree[WT]?.find((tab) => tab.id === tabId)
}

function lastParams(): Record<string, unknown> {
  return callRuntimeRpc.mock.calls.at(-1)?.[2] ?? {}
}

function lastPaneKey(): string {
  return String(lastParams().paneKey)
}

function launch() {
  return launchAgentThroughHost({
    agent: 'claude',
    worktreeId: WT,
    groupId: store.getState().activeGroupIdByWorktree[WT],
    prompt: 'fix the failing checks',
    agentArgs: null,
    launchSource: 'source_control_recovery'
  })
}

/** What the host does first: it takes the pane, by asking this window to show the tab. */
function hostTakesPane(tabId: string): void {
  const tab = launchTab(tabId)!
  releaseAgentLaunchPaneSpawn(tab.id, tab.agentLaunchPane!.leafId)
}

beforeEach(() => {
  store = createTestStore()
  testStore.current = store
  callRuntimeRpc.mockReset()
  store.getState().setActiveWorktree(WT)
  store.getState().createUnifiedTab(WT, 'terminal')
})

describe('a desktop launch through the host', () => {
  it('shows its tab at the click, in its split, waiting for the host before it spawns', () => {
    const reply = deferred<unknown>()
    callRuntimeRpc.mockReturnValue(reply.promise)

    const { tabId } = launch()

    const tab = launchTab(tabId)!
    expect(tab).toMatchObject({ ptyId: null, launchAgent: 'claude' })
    const leafId = tab.agentLaunchPane!.leafId
    expect(agentLaunchPaneSpawnHold(tab.id, leafId)).not.toBeNull()
    expect(agentLaunchPanePrompt(tab.id)).toBe('fix the failing checks')
    expect(store.getState().activeTabId).toBe(tabId)
    // No prompt: the window pastes it, as main does, once the agent runs.
    expect(callRuntimeRpc).toHaveBeenCalledWith({ kind: 'local' }, 'agent.launchReplay', {
      agent: 'claude',
      target: { kind: 'existing', worktree: `id:${WT}` },
      agentArgs: null,
      launchSource: 'source_control_recovery',
      placement: { groupId: store.getState().activeGroupIdByWorktree[WT] },
      presentation: 'focused',
      operationId: expect.stringMatching(/^\d+-[0-9a-f]{32}$/),
      paneKey: `${tabId}:${leafId}`
    })
  })

  // Why: a floating launch must leave the main window's selection alone, as main's own tab does.
  it('keeps a launch that must not take the selection in the background', () => {
    callRuntimeRpc.mockReturnValue(new Promise(() => {}))
    const before = store.getState().activeTabId

    const { tabId } = launchAgentThroughHost({
      agent: 'claude',
      worktreeId: WT,
      prompt: '',
      activate: false
    })

    expect(launchTab(tabId)).toBeDefined()
    expect(store.getState().activeTabId).toBe(before)
    expect(lastParams().presentation).toBe('background')
  })

  it('names every click as its own operation', () => {
    callRuntimeRpc.mockReturnValue(new Promise(() => {}))
    launch()
    const first = lastParams()
    launch()
    const second = lastParams()
    expect(second.operationId).not.toBe(first.operationId)
    expect(second.paneKey).not.toBe(first.paneKey)
  })

  it('says the agent started only once the host answers, with its pane attached', async () => {
    const reply = deferred<unknown>()
    callRuntimeRpc.mockReturnValue(reply.promise)
    const { tabId, outcome } = launch()
    const settled = vi.fn()
    void outcome.then(settled)
    hostTakesPane(tabId)
    await Promise.resolve()
    expect(settled).not.toHaveBeenCalled()

    reply.resolve(terminalResult(lastPaneKey()))

    await expect(outcome).resolves.toEqual({ kind: 'started' })
    expect(launchTab(tabId)).toBeDefined()
  })

  it('takes its tab back on a refusal, before the pane ever spawns', async () => {
    const reply = deferred<unknown>()
    callRuntimeRpc.mockReturnValue(reply.promise)
    const { tabId, outcome } = launch()

    reply.reject(rpcError('agent_session_operation_conflict'))

    await expect(outcome).resolves.toEqual({
      kind: 'not-started',
      unconfirmed: false,
      code: 'agent_session_operation_conflict'
    })
    expect(launchTab(tabId)).toBeUndefined()
  })

  it('leaves a launch the host took to its pane, which says how it ended', async () => {
    const reply = deferred<unknown>()
    callRuntimeRpc.mockReturnValue(reply.promise)
    const { tabId, outcome } = launch()
    hostTakesPane(tabId)

    reply.reject(rpcError('agent_session_operation_unknown'))

    await expect(outcome).resolves.toEqual({ kind: 'pane-says' })
    expect(launchTab(tabId)).toBeDefined()
  })

  it('never leaves a pane the host did not take, which would open as a shell', async () => {
    const reply = deferred<unknown>()
    callRuntimeRpc.mockReturnValue(reply.promise)
    const { tabId, outcome } = launch()

    reply.reject(rpcError('worktree_not_found'))

    await expect(outcome).resolves.toEqual({
      kind: 'not-started',
      unconfirmed: false,
      code: 'worktree_not_found'
    })
    expect(launchTab(tabId)).toBeUndefined()
  })

  // Why: the close was the user's own, as on the phone's "+".
  it('says nothing more when the user closed the tab while it started', async () => {
    callRuntimeRpc.mockRejectedValueOnce(rpcError('agent_launch_tab_closed'))
    await expect(launch().outcome).resolves.toEqual({ kind: 'closed-by-user' })
  })
})
