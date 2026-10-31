import { EVERY_AGENT_CHAT } from '../../../shared/native-chat/every-agent-chat.test-fixture'
import { agentMenuShortcutLabels } from '../components/tab-bar/agent-menu-shortcut-labels'
import { makeWorktree, TEST_REPO } from '@/store/slices/worktrees-slice-test-fixtures'
import { getDefaultSourceControlAiSettings } from '../../../shared/source-control-ai-settings'
import { afterEach, assert, beforeEach, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../shared/constants'
import { pr } from '@/hooks/composer-state/composer-review-base-test-fixture'
import { createCompatibleRuntimeStatusResponse } from '@/runtime/runtime-compatibility-test-fixture'
import { MANAGED_RUNTIME_INSTALL_RUNTIME_CAPABILITY as INSTALL } from '../../../shared/managed-runtime-install'
import {
  STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY as CATALOG,
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY as CHAT,
  STRUCTURED_AGENT_SESSION_AVAILABILITY_RUNTIME_CAPABILITY as HEALTH,
  STRUCTURED_AGENT_SESSION_CLIENT_LAUNCH_MODE_CAPABILITY as MODE
} from '../../../shared/protocol-version'
const rpc = vi.hoisted(() => ({ call: vi.fn(), subscribe: vi.fn(), direct: vi.fn() }))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: rpc.call }))
vi.mock('@/runtime/runtime-rpc-subscribe', () => ({ subscribeRuntimeRpc: rpc.subscribe }))
import { useAppStore } from '@/store'
import { resetHostStructuredAgentsForTests } from '@/runtime/host-structured-agents'
import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/local-runtime-capabilities'
import { acquireAgentLaunchChoices, holdChatProgramFacts } from './host-chat-program-acquisition'
import * as chat from './host-chat-program'
import { resolveQuickWorkspaceAgentSelection } from './quick-workspace-agent-selection'
import { resolveChecksActionAgent, startFixChecksAgent } from './fix-checks-agent-launch'
vi.mock('./launch-work-item-direct', () => ({ launchWorkItemDirect: rpc.direct }))
const CAPS = [CHAT, CATALOG, INSTALL, HEALTH, MODE]
const workspace = { kind: 'git-worktree', runtimeEnvironmentId: 'B' } as const
const host = { executionHostId: 'runtime:B', hostCapabilities: CAPS }
const initial = useAppStore.getState()
const runtime = createCompatibleRuntimeStatusResponse()
assert(runtime.ok, 'Expected compatible runtime fixture')
const status = (runtimeId = 'r1', connectionGeneration?: number) => ({
  connectionGeneration,
  status: { ...runtime.result, runtimeId, capabilities: CAPS },
  checkedAt: 1
})
const managed = { agent: 'antigravity', capabilities: {}, managedRuntime: true }
const catalog = { agents: [managed, { agent: 'grok', capabilities: {} }] }
const frame = (agent: string, chatProgram: string) => ({
  type: 'availability',
  agents: [{ agent, state: 'available', chatProgram }]
})
const flush = () =>
  Array.from({ length: 12 }).reduce<Promise<void>>((tick) => tick.then(), Promise.resolve())
beforeEach(() => {
  rpc.call.mockReset().mockResolvedValue(catalog)
  rpc.subscribe.mockReset().mockResolvedValue({ unsubscribe: vi.fn() })
  setLocalRuntimeCapabilitiesForTests(CAPS)
  useAppStore.setState({
    settings: { ...getDefaultSettings('/tmp'), nativeChatProviders: EVERY_AGENT_CHAT },
    runtimeStatusByEnvironmentId: new Map([['B', status()]])
  })
})
afterEach(() => {
  vi.useRealTimers()
  resetHostStructuredAgentsForTests()
  setLocalRuntimeCapabilitiesForTests(null)
  useAppStore.setState(initial, true)
})
it('acquires inactive B independently of detection, preserves unknown truth and selected catalog intent', async () => {
  const catalogReply = Promise.withResolvers<unknown>()
  rpc.call.mockReturnValue(catalogReply.promise)
  const action = acquireAgentLaunchChoices(workspace, async () => [])
  await flush()
  expect(rpc.subscribe.mock.calls[0][0]).toEqual({ kind: 'environment', environmentId: 'B' })
  expect(chat.agentChoicePending(useAppStore.getState(), 'antigravity', workspace, [])).toBe(true)
  const quick = resolveQuickWorkspaceAgentSelection({
    quickAgentOverride: 'antigravity',
    preferredQuickAgent: null,
    detectedAgentIds: [],
    selectedChoiceUnresolved: true
  })
  expect(quick.quickAgentOverride).toBe('antigravity')
  rpc.subscribe.mock.calls[0][3].onEvent(frame('grok', 'available'))
  catalogReply.resolve(catalog)
  expect((await action).offered).toEqual(['grok'])
  useAppStore.setState((current) => ({
    repos: [TEST_REPO],
    worktreesByRepo: {
      [TEST_REPO.id]: [
        makeWorktree({ id: 'known-chat', repoId: TEST_REPO.id, hostId: 'runtime:B' })
      ]
    },
    runtimeDetectedAgentIds: {},
    settings: { ...current.settings!, defaultTuiAgent: 'grok', nativeChatProviders: { grok: true } }
  }))
  expect(agentMenuShortcutLabels('known-chat', {}, 'darwin').get('grok')).toBe('⌘⌥T')
  const state = useAppStore.getState()
  const lease = holdChatProgramFacts(chat.resolveChatProgramContext(state, workspace))
  rpc.subscribe.mock.calls.at(-1)![3].onEvent(frame('grok', 'future-program'))
  expect(chat.readChatProgram(state, 'grok', host, ['grok'])).toBe('unknown')
  expect(chat.agentChoiceOpensAsChat(state, 'grok', workspace, ['grok'])).toBe(true)
  lease.release()
})
it('releases a pending stream at the chat deadline while slow ordinary detection keeps waiting', async () => {
  vi.useFakeTimers()
  const handle = Promise.withResolvers<{ unsubscribe: () => void }>()
  const detect = Promise.withResolvers<[]>()
  rpc.subscribe.mockReturnValue(handle.promise)
  const action = acquireAgentLaunchChoices(workspace, () => detect.promise)
  const settled = vi.fn()
  void action.then(settled)
  await flush()
  await vi.advanceTimersByTimeAsync(5000)
  expect(settled).not.toHaveBeenCalled()
  useAppStore.setState({ runtimeStatusByEnvironmentId: new Map([['B', status('r1', 1)]]) })
  expect(rpc.subscribe).toHaveBeenCalledOnce()
  const unsubscribe = vi.fn()
  handle.resolve({ unsubscribe })
  await flush()
  expect(unsubscribe).toHaveBeenCalledOnce()
  detect.resolve([])
  await action
})
it('keeps one still-detecting action on the current open through learning/reconnect', async () => {
  useAppStore.setState({ runtimeStatusByEnvironmentId: new Map() })
  const detect = Promise.withResolvers<[]>()
  const settled = vi.fn()
  const action = acquireAgentLaunchChoices(workspace, () => detect.promise).then(settled)
  useAppStore.setState({ runtimeStatusByEnvironmentId: new Map([['B', status()]]) })
  await flush()
  rpc.subscribe.mock.calls.at(-1)![3].onEvent(frame('grok', 'available'))
  rpc.subscribe.mock.calls.at(-1)![3].onClose()
  useAppStore.setState({ runtimeStatusByEnvironmentId: new Map([['B', status('r1', 1)]]) })
  detect.resolve([])
  await flush()
  expect(rpc.subscribe).toHaveBeenCalledTimes(2)
  expect(settled).not.toHaveBeenCalled()
  rpc.subscribe.mock.calls.at(-1)![3].onClose()
  await action
})
it('adapts only absent publication on older hosts and shares the saved Checks gate with pre-create execution', async () => {
  setLocalRuntimeCapabilitiesForTests([CHAT, CATALOG, INSTALL])
  const local = { kind: 'git-worktree' } as const
  const settings = getDefaultSettings('/tmp')
  settings.nativeChatProviders = EVERY_AGENT_CHAT
  settings.sourceControlAi = getDefaultSourceControlAiSettings()
  settings.sourceControlAi.actions = { fixChecks: { agentId: 'antigravity' } }
  useAppStore.setState({ settings, ensureDetectedAgents: async () => [] })
  await acquireAgentLaunchChoices(local, async () => [])
  const checksAgent = (actionId: 'fixChecks' | 'resolveComments') =>
    resolveChecksActionAgent(useAppStore.getState(), actionId, undefined, local, [])
  expect(checksAgent('fixChecks')).toBe('antigravity')
  expect(checksAgent('resolveComments')).toBeNull()
  rpc.direct.mockResolvedValue(true)
  await startFixChecksAgent({
    repoId: 'missing',
    basePrompt: 'fix checks',
    item: { ...pr, repoId: 'missing' },
    launchSource: 'task_page',
    openModalFallback: vi.fn()
  })
  expect(rpc.direct.mock.lastCall?.[0].agentOverride).toBe('antigravity')
  useAppStore.setState({ settings: { ...settings, disabledTuiAgents: ['antigravity'] } })
  expect(checksAgent('fixChecks')).toBeNull()
  const localChat = { executionHostId: 'local', hostCapabilities: [CHAT] }
  expect(chat.readChatProgram(useAppStore.getState(), 'antigravity', localChat, [])).toBe('missing')
})
