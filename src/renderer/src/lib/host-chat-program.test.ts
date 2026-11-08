import { agentTabLaunchStore } from './agent-session/launch/new-tab/launch-agent-execution-context'
import { getRuntimeAgentInventoryKey } from '@/store/slices/agent-inventory/runtime-agent-inventory-key'
import { resolveDefaultAgentForWorkspace } from './agent-tab-shortcuts'
import { EVERY_AGENT_CHAT } from '../../../shared/native-chat/every-agent-chat.test-fixture'

import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import { TEST_REPO } from '@/store/repos/repo.test-fixture'

import { afterEach, assert, beforeEach, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../shared/constants'

import { clearHostAgentMenuSettingsForTests } from '@/runtime/agent-launch-settings/host-agent-launch-preferences-resource'

import { createCompatibleRuntimeStatusResponse } from '@/runtime/rpc/testing/runtime-compatibility-test-fixture'
import { MANAGED_RUNTIME_INSTALL_RUNTIME_CAPABILITY as INSTALL } from '../../../shared/managed-runtime-install'
import {
  STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY as CATALOG,
  STRUCTURED_AGENT_SESSION_AVAILABILITY_RUNTIME_CAPABILITY as HEALTH
} from '../../../shared/agent-session/structured-agent-session-surface-capabilities'
import {
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY as CHAT,
  STRUCTURED_AGENT_SESSION_CLIENT_LAUNCH_MODE_CAPABILITY as MODE
} from '../../../shared/agent-session/agent-session-runtime-capabilities'
const rpc = vi.hoisted(() => ({
  call: vi.fn(),
  subscribe: vi.fn(),
  direct: vi.fn(),
  supports: vi.fn()
}))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({
  callRuntimeRpc: rpc.call
}))
vi.mock('@/runtime/rpc/compatibility/runtime-capability-proof', () => ({
  runtimeEnvironmentSupportsCapability: rpc.supports
}))
vi.mock('@/runtime/rpc/subscriptions/runtime-rpc-subscribe', () => ({
  subscribeRuntimeRpc: rpc.subscribe
}))
import { useAppStore } from '@/store'
import { resetHostStructuredAgentsForTests } from '@/runtime/native-chat/agent-catalogs/host-structured-agents'
import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/hosts/capabilities/local-runtime-capabilities'
import { acquireAgentLaunchChoices } from './host-chat-program-acquisition'

vi.mock('./workspace/creation/work-item/launch-work-item-direct', () => ({
  launchWorkItemDirect: rpc.direct
}))
const CAPS = [CHAT, CATALOG, INSTALL, HEALTH, MODE]
const workspace = { kind: 'git-worktree', runtimeEnvironmentId: 'B' } as const

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
  rpc.supports.mockReset().mockResolvedValue(true)
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
  clearHostAgentMenuSettingsForTests()
  setLocalRuntimeCapabilitiesForTests(null)
  useAppStore.setState(initial, true)
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

it('keeps default-agent discovery on the captured workspace copy while another copy is selected', async () => {
  const worktreeId = 'captured-workspace'
  const target = { kind: 'git-worktree', worktreeId } as const
  rpc.call.mockResolvedValue({
    agents: [
      { agent: 'claude', capabilities: {} },
      { agent: 'codex', capabilities: {} }
    ]
  })
  useAppStore.setState({
    repos: [TEST_REPO],
    worktreesByRepo: {
      [TEST_REPO.id]: [
        makeWorktree({ id: worktreeId, repoId: TEST_REPO.id, hostId: 'runtime:A' }),
        makeWorktree({ id: worktreeId, repoId: TEST_REPO.id, hostId: 'runtime:B' })
      ]
    },
    activeWorktreeId: worktreeId,
    activeWorkspaceExecutionHostId: 'runtime:A',
    runtimeStatusByEnvironmentId: new Map([
      ['A', status('a')],
      ['B', status('b')]
    ]),
    runtimeDetectedAgentIds: {
      [getRuntimeAgentInventoryKey('A', worktreeId)]: ['claude'],
      [getRuntimeAgentInventoryKey('B', worktreeId)]: ['codex']
    },
    settings: { ...getDefaultSettings('/tmp'), agentDefaultSurface: 'chat' }
  })
  const getState = () =>
    agentTabLaunchStore(useAppStore.getState(), {
      worktreeId,
      workspaceExecutionHostId: 'runtime:A'
    })
  const detected = Promise.withResolvers<['claude']>()
  const action = acquireAgentLaunchChoices(
    target,
    () => detected.promise,
    undefined,
    false,
    getState
  )
  await flush()
  rpc.subscribe.mock.calls.at(-1)![3].onEvent(frame('claude', 'available'))
  useAppStore.setState({ activeWorkspaceExecutionHostId: 'runtime:B' })
  detected.resolve(['claude'])
  const choices = await action
  expect(choices).toEqual({ detected: ['claude'], offered: ['claude'] })
  expect(
    resolveDefaultAgentForWorkspace({
      defaultTuiAgent: null,
      detectedAgentIds: choices.detected,
      disabledTuiAgents: [],
      chatIn: { store: getState(), workspace: target }
    })
  ).toBe('claude')
})
