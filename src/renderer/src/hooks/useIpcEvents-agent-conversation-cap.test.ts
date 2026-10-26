import { afterEach, expect, it, vi } from 'vitest'
import type { UseBoundStore, StoreApi } from 'zustand'
import type { AppState } from '../store/types'
import type { AgentStatusIpcPayload } from '../../../shared/agent-status-types'
import { agentSessionRefusalError } from '../../../shared/agent-session-wire-refusals'
import type { AgentStatusSetData } from './ipc-events-agent-status-store-test-fixtures'
import {
  createTestStore,
  makeTab,
  makeWorktree,
  TEST_REPO
} from '../store/slices/store-test-helpers'
import { buildWindowApi } from './ipc-events-agent-status-window-test-fixtures'
import { collectLeafIds } from '../../../shared/terminal-pane-layout-tree'
import { captureTerminalSurfaceIdentity } from '../../../shared/terminal-tab-close'
import { adoptsCliConversations } from '../../../shared/structured-agent-cli-conversation-adoption'
import {
  collectAgentPaneConversations,
  resolvePaneLastAgentConversation
} from '@/lib/ai-vault-tab-title-requests'
import {
  transferAgentPaneAuthorityAlias,
  resetAgentPaneAuthorityAliasesForTests
} from '../store/slices/agent-pane-authority'
import * as capacity from '../store/slices/agent-status-capacity-eviction'
import * as switches from '../lib/pending-conversation-surface-switches'

const mocks = vi.hoisted(() => {
  const store: { current?: UseBoundStore<StoreApi<AppState>> } = {}
  return {
    store,
    support: vi.fn(async () => true),
    call: vi.fn(),
    rpc: vi.fn(),
    launch: vi.fn(),
    toast: vi.fn()
  }
})
vi.mock('@/store', () => ({
  get useAppStore() {
    return mocks.store.current
  }
}))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  supportsInPlaceSwitch: mocks.support,
  supportsStructuredAgentSessionCliSource: async () => true,
  callStructuredAgentSession: mocks.call
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: mocks.rpc }))
vi.mock('@/lib/launch-ai-vault-session', () => ({ launchAiVaultSessionInNewTab: mocks.launch }))
vi.mock('@/runtime/local-runtime-capabilities', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  readLocalRuntimeCapabilitiesOrUnknown: () => [
    'agent-session.structured.v1',
    'agent-session.structured.agents.v1',
    'agent-session.structured.switch.v1:codex'
  ]
}))
vi.mock('@/runtime/host-structured-agents', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  readHostStructuredAgents: () => [{ agent: 'codex', capabilities: {} }]
}))
vi.mock('./agent-hook-completion-notifications', () => ({
  observeAgentHookCompletionForNotification: vi.fn(),
  syncAgentHookCompletionNotificationsForStoreUpdate: vi.fn()
}))
vi.mock('sonner', () => ({ toast: { error: mocks.toast } }))
const cleanup: (() => void)[] = []
const running: Promise<void>[] = []
afterEach(async () => {
  cleanup
    .splice(0)
    .toReversed()
    .forEach((close) => close())
  await Promise.allSettled(running.splice(0))
  resetAgentPaneAuthorityAliasesForTests()
  vi.restoreAllMocks()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})
const leaf = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const pane = (tab: string, n = 1) => `${tab}:${leaf(n)}`
const layout = (n: number) => ({
  root: { type: 'leaf' as const, leafId: leaf(n) },
  activeLeafId: leaf(n),
  expandedLeafId: null
})
it.each([600, 6000])(
  'bounds real publications across held switches and retries at %i callbacks',
  async (n) => {
    vi.useFakeTimers()
    vi.setSystemTime(1_800_000_000_000)
    vi.clearAllMocks()
    const store = createTestStore()
    mocks.store.current = store
    const tabs = ['cli', 'retry', 'root-b', 'root-c', 'rootless'].map((id) =>
      makeTab({ id, worktreeId: 'wt', createdAt: 1 })
    )
    const roots = [pane('retry'), pane('root-b'), pane('root-c')]
    store.setState({
      workspaceSessionReady: true,
      repos: [TEST_REPO],
      worktreesByRepo: { [TEST_REPO.id]: [makeWorktree({ id: 'wt', repoId: TEST_REPO.id })] },
      tabsByWorktree: { wt: tabs },
      terminalLayoutsByTabId: {
        ...Object.fromEntries(
          tabs.filter((tab) => tab.id !== 'rootless').map((tab) => [tab.id, layout(1)])
        ),
        rootless: { root: null, activeLeafId: null, expandedLeafId: null }
      }
    })
    let onSet: ((data: AgentStatusSetData) => void) | undefined
    vi.stubGlobal(
      'window',
      buildWindowApi({
        onSet: (callback) => {
          onSet = callback
          return () => {}
        }
      })
    )
    const { registerAgentStatusIpcBridge } = await import('./ipc-events/agent-status-ipc-bridge')
    const { runCliChatResume } = await import('../components/tab-bar/cli-chat-resume-run')
    const { resolveCliChatResumeSource } =
      await import('../components/tab-bar/cli-chat-resume-source')
    const { runNativeChatCliSwitch } =
      await import('../components/tab-bar/native-chat-cli-switch-run')
    const unsubs: (() => void)[] = []
    const bridge = registerAgentStatusIpcBridge(unsubs)
    cleanup.push(bridge.disposeAsyncState, bridge.unsubscribeStore, ...unsubs)
    await Promise.resolve()
    let callbacks = 0
    const emit = async (key: string, id = key) => {
      const data: AgentStatusIpcPayload & AgentStatusSetData = {
        paneKey: key,
        state: 'done',
        prompt: '',
        agentType: 'codex',
        providerSessionOnly: true,
        worktreeId: 'wt',
        terminalHandle: `term-${key}`,
        providerSession: { key: 'session_id', id },
        connectionId: null,
        receivedAt: Date.now(),
        stateStartedAt: Date.now()
      }
      if (!onSet) {
        throw new Error('Missing bridge callback')
      }
      onSet(data)
      callbacks += 1
      await vi.advanceTimersByTimeAsync(34)
      expect(store.getState().agentConversationsByPaneKey[key]?.providerSession.id).toBe(id)
      store.getState().clearSleepingAgentSession(key)
    }
    for (const key of [
      pane('cli'),
      ...roots,
      pane('cli', 2),
      pane('retry', 2),
      pane('native'),
      pane('alias-old'),
      pane('alias-new')
    ]) {
      await emit(key, key === pane('cli') || key === pane('retry') ? 'conversation' : key)
    }
    const first = resolveCliChatResumeSource(store.getState(), {
      tab: { id: 'cli', worktreeId: 'wt' },
      paneKey: pane('cli')
    })!
    const retry = resolveCliChatResumeSource(store.getState(), {
      tab: { id: 'retry', worktreeId: 'wt' },
      paneKey: pane('retry')
    })!
    expect(first.providerSessionId).toBe('conversation')
    expect(retry.providerSessionId).toBe('conversation')
    mocks.rpc.mockImplementation(async (_target, method, args) => {
      expect(method).toBe('terminal.resolvePane')
      const tabId = args.paneKey.split(':')[0]
      const identity = captureTerminalSurfaceIdentity(store.getState(), 'wt', tabId, leaf(1))!
      return {
        terminal: {
          handle: `handle-${tabId}`,
          ptyId: identity.ptyId,
          incarnationId: 'incarnation',
          presentation: { identity: { ...identity, incarnationId: 'incarnation' }, holders: [] }
        }
      }
    })
    const refusal = {
      ok: false as const,
      refusal: { code: 'agent_session_operation_invalid', message: 'Not admitted' }
    }
    const oldAnswer = Promise.withResolvers<typeof refusal>()
    const newAnswer = Promise.withResolvers<typeof refusal>()
    const nativeAnswer = Promise.withResolvers<{ source: unknown }>()
    const nativeLaunch = Promise.withResolvers<{ status: 'created' }>()
    cleanup.push(() => {
      oldAnswer.resolve(refusal)
      newAnswer.resolve(refusal)
      nativeAnswer.resolve({ source: null })
      nativeLaunch.resolve({ status: 'created' })
    })
    const returns = [oldAnswer, newAnswer]
    mocks.call.mockImplementation((_target, method) =>
      method === 'agentSession.switchToChat' ? returns.shift()!.promise : nativeAnswer.promise
    )
    mocks.launch.mockReturnValue({ tabId: null, runtimeLaunch: nativeLaunch.promise })
    const ownerRefusal = agentSessionRefusalError('agent_session_conflict', {
      reason: 'conversationHeldElsewhere',
      owner: { sessionId: 'existing', workspaceId: 'wt' }
    })
    mocks.support.mockRejectedValueOnce(ownerRefusal)
    const old = runCliChatResume(first)
    running.push(old)
    await vi.waitFor(() => expect(mocks.call).toHaveBeenCalledTimes(1))
    const native = runNativeChatCliSwitch({
      sessionId: 'native-session',
      workspaceId: 'wt',
      executionHostId: 'local',
      agent: 'codex',
      chatTabId: 'native'
    })
    running.push(native)
    await vi.waitFor(() => expect(mocks.call).toHaveBeenCalledTimes(2))
    transferAgentPaneAuthorityAlias({ fromPaneKey: first.paneKey, toPaneKey: pane('alias-old') })
    const { cli: _removed, ...withoutCli } = store.getState().terminalLayoutsByTabId
    store.setState({
      terminalLayoutsByTabId: withoutCli,
      tabsByWorktree: { wt: tabs.filter((tab) => tab.id !== 'cli') }
    })
    mocks.support.mockRejectedValueOnce(ownerRefusal)
    const newer = runCliChatResume(retry)
    running.push(newer)
    await vi.waitFor(() => expect(mocks.call).toHaveBeenCalledTimes(3))
    transferAgentPaneAuthorityAlias({ fromPaneKey: retry.paneKey, toPaneKey: pane('alias-new') })
    let protectedKeys = [
      first.paneKey,
      pane('cli', 2),
      retry.paneKey,
      pane('retry', 2),
      pane('alias-old'),
      pane('alias-new'),
      pane('native')
    ]
    let publications = 0
    const assertBound = () => {
      const state = store.getState()
      const rooted = new Set(
        Object.entries(state.terminalLayoutsByTabId).flatMap(([tab, tree]) =>
          collectLeafIds(tree.root).map((id) => `${tab}:${id}`)
        )
      )
      const keys = Object.keys(state.agentConversationsByPaneKey)
      expect(
        keys.filter((key) => !rooted.has(key) && !protectedKeys.includes(key)).length
      ).toBeLessThanOrEqual(500)
      expect(keys.length).toBeLessThanOrEqual(
        rooted.size + 500 + protectedKeys.filter((key) => !rooted.has(key)).length
      )
      for (const key of [...roots, ...protectedKeys]) {
        expect(state.agentConversationsByPaneKey[key]).toBeDefined()
      }
      publications += 1
    }
    cleanup.push(store.subscribe(assertBound))
    const batches = vi.spyOn(store.getState(), 'transactAgentStatuses')
    const records = vi.spyOn(store.getState(), 'recordAgentProviderSession')
    let classifiedKeys = 0
    let protectionEntries = 0
    const classify = capacity.classifyPaneKeyLiveness
    const protect = switches.protectedConversationPaneKeys
    const classifier = vi.spyOn(capacity, 'classifyPaneKeyLiveness').mockImplementation((state) => {
      const lookup = classify(state)
      return (key) => {
        classifiedKeys += 1
        return lookup(key)
      }
    })
    vi.spyOn(switches, 'protectedConversationPaneKeys').mockImplementation((entries) => {
      protectionEntries += Object.keys(entries).length
      return protect(entries)
    })
    const deliveredBefore = callbacks
    for (let index = 0; index < n; index += 1) {
      await emit(pane(index % 2 ? 'unknown' : 'rootless', index + 10))
    }
    expect(callbacks - deliveredBefore).toBe(n)
    expect(records).toHaveBeenCalledTimes(n)
    expect(batches).toHaveBeenCalledTimes(0)
    expect(publications).toBeGreaterThanOrEqual(n)
    expect(publications).toBeLessThanOrEqual(3 * n)
    expect(classifier.mock.calls.length).toBeLessThanOrEqual(publications)
    expect(classifiedKeys).toBeLessThanOrEqual(510 * publications)
    expect(Object.keys(store.getState().agentConversationsByPaneKey)).toHaveLength(509)
    const oldest = pane(n % 2 ? 'unknown' : 'rootless', n - 500 + 10)
    await emit(oldest, 'replacement-does-not-refresh-residency')
    store.setState(
      {
        ...store.getState(),
        agentConversationsByPaneKey: Object.fromEntries(
          Object.entries(store.getState().agentConversationsByPaneKey).toReversed()
        )
      },
      true
    )
    await emit(pane('unknown', n + 10))
    expect(store.getState().agentConversationsByPaneKey[oldest]).toBeUndefined()
    let nestedWrites = 0
    const stopNested = store.subscribe(() => {
      if (nestedWrites++ === 0) {
        store.setState((state) => ({
          agentConversationsByPaneKey: state.agentConversationsByPaneKey
        }))
      }
    })
    store.setState({ activeWorktreeId: 'wt' })
    stopNested()
    expect(nestedWrites).toBe(2)
    protectedKeys = [retry.paneKey, pane('retry', 2), pane('alias-new'), pane('native')]
    oldAnswer.resolve(refusal)
    await old
    expect(Object.keys(store.getState().agentConversationsByPaneKey)).toHaveLength(506)
    expect(store.getState().agentConversationsByPaneKey[pane('alias-new')]).toBeDefined()
    expect(mocks.call).toHaveBeenCalledTimes(3)
    protectedKeys = [pane('native')]
    newAnswer.resolve(refusal)
    await newer
    expect(Object.keys(store.getState().agentConversationsByPaneKey)).toHaveLength(504)
    nativeAnswer.resolve({
      source: {
        agent: 'codex',
        sourceAgent: 'codex',
        sessionId: 'native-provider',
        filePath: '/repo/rollout.jsonl',
        cwd: '/repo',
        codexHome: null,
        executionHostPlatform: 'darwin'
      }
    })
    await vi.waitFor(() => expect(mocks.launch).toHaveBeenCalledOnce())
    await emit(pane('pressure-after-native-receipt', n + 11))
    protectedKeys = []
    nativeLaunch.resolve({ status: 'created' })
    await native
    expect(Object.keys(store.getState().agentConversationsByPaneKey)).toHaveLength(503)
    for (const key of roots) {
      expect(
        resolvePaneLastAgentConversation(
          store.getState(),
          { worktreeId: 'wt', paneKey: key },
          adoptsCliConversations
        )?.providerSession.id
      ).toBe(key === pane('retry') ? 'conversation' : key)
    }
    expect(
      collectAgentPaneConversations(store.getState(), adoptsCliConversations, { allPanes: true })
    ).toEqual(expect.arrayContaining(roots.map((paneKey) => expect.objectContaining({ paneKey }))))
    expect(mocks.rpc.mock.calls.every(([, method]) => method !== 'terminal.close')).toBe(true)
    expect(classifier.mock.calls.length).toBeLessThanOrEqual(publications)
    expect(classifiedKeys).toBeLessThanOrEqual(510 * publications)
    expect(publications).toBeLessThanOrEqual(3 * n + 64)
    console.info('CAP_COUNTS', {
      n,
      callbacks,
      batches: batches.mock.calls.length,
      records: records.mock.calls.length,
      publications,
      classifierBuilds: classifier.mock.calls.length,
      classifiedKeys,
      protectionEntries,
      retained: Object.keys(store.getState().agentConversationsByPaneKey).length
    })
  },
  120_000
)
