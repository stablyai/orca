// @vitest-environment happy-dom
// A card's located terminal that this window holds no tab for opens that same pane, through the
// host's own pane resolver; the card's saved address is never looked up again.
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  callRuntimeRpc: vi.fn(),
  focusRenderer: vi.fn((_handle: string, _environmentId?: string | null) => false),
  focusRuntime: vi.fn(async (_handle: string, _environmentId: string | null) => undefined),
  toastInfo: vi.fn(),
  toastError: vi.fn()
}))
vi.mock('@/components/terminal-pane/terminal-handle-links', () => ({
  focusRendererTerminalHandle: mocks.focusRenderer,
  focusRuntimeTerminalHandle: mocks.focusRuntime
}))
vi.mock('@/runtime/runtime-rpc-client', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  callRuntimeRpc: mocks.callRuntimeRpc
}))
vi.mock('sonner', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  toast: { info: mocks.toastInfo, error: mocks.toastError }
}))

import { useAppStore } from '@/store'
import { makeTab } from '@/store/slices/store-test-helpers'
import { openAgentMessageSender } from '@/lib/open-agent-message-sender'
import { RuntimeRpcCallError } from '@/runtime/runtime-rpc-result'
import { useAgentMessageSenderView } from '@/components/native-chat/native-chat-agent-message-sender-view'
import {
  agentMessageSenderOpens,
  resolveAgentMessageSenderTarget
} from '@/components/native-chat/native-chat-agent-message-sender-target'
import {
  initialStore,
  LEAF,
  resetSenderStore,
  status
} from '@/components/native-chat/native-chat-agent-sender.test-fixture'
import { OrcaRuntimeService } from '../../src/main/runtime/orca-runtime'
import { RpcDispatcher } from '../../src/main/runtime/rpc/dispatcher'
import { TERMINAL_QUERY_METHODS } from '../../src/main/runtime/rpc/methods/terminal/terminal-query-methods'
import { MIRROR_LEAVES_STEP_1 } from '../../src/main/runtime/runtime-leaf-record-projection.test-fixture'
import type { AgentSenderAssociation } from '../../src/shared/agent-sender-associations'
import type { AgentMessageSender } from '../../src/shared/agent-session/agent-session-message-source'
import type { RuntimeClientTarget } from '../../src/shared/runtime-client-target'
import { toRemoteRuntimePtyId } from '../../src/shared/remote-runtime/remote-runtime-pty-id'
import { toWebTerminalSurfaceTabId } from '../../src/shared/terminal-surface-id'

const LOCAL: RuntimeClientTarget = { kind: 'local' }
const PAIRED: RuntimeClientTarget = { kind: 'environment', environmentId: 'paired' }
const pane = (tab: string) => `${tab}:${LEAF}`

/** A real host runtime whose terminals are leaves; its RPC server answers the window. */
function hostRuntime() {
  const runtime = new OrcaRuntimeService(null)
  const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_QUERY_METHODS })
  const open = (tabId: string, worktreeId: string): string => {
    const leaf = {
      ...MIRROR_LEAVES_STEP_1[0],
      tabId,
      leafId: LEAF,
      worktreeId,
      ptyId: `pty-${tabId}`,
      connected: true
    }
    runtime['leaves'].set(runtime['getLeafKey'](tabId, LEAF), leaf)
    return runtime['issueHandle'](leaf)
  }
  const close = (tabId: string) => runtime['leaves'].delete(runtime['getLeafKey'](tabId, LEAF))
  const answer = async (method: string, params: unknown) => {
    const response = await dispatcher.dispatch({
      id: `rpc_${method}`,
      authToken: 'test-token',
      method,
      params
    })
    if (!response.ok) {
      throw new RuntimeRpcCallError(response)
    }
    return response.result
  }
  return { open, close, answer }
}

let host: ReturnType<typeof hostRuntime>
let calls: { target: unknown; method: string; params: unknown }[] = []
let duringLookup = () => {}

const worker = (address: string): AgentMessageSender => ({
  party: { address, terminalHandle: address, orcaSessionId: null },
  name: 'Worker',
  agent: 'claude'
})
const publish = (hostId: string, associations: AgentSenderAssociation[], revision = 1) =>
  useAppStore.getState().setAgentSenderPublication(hostId, {
    associations,
    principals: [],
    attachments: [],
    revision: { epoch: 'host', revision }
  })
const open = (sender: AgentMessageSender, target: RuntimeClientTarget = LOCAL) =>
  openAgentMessageSender(
    { kind: 'agent', senders: [sender], orchestration: null },
    sender,
    'workspace',
    target,
    'first',
    'Worker'
  )
const asked = (method: string) => calls.filter((call) => call.method === method)

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(2_000_000)
  resetSenderStore()
  host = hostRuntime()
  calls = []
  duringLookup = () => {}
  mocks.callRuntimeRpc.mockImplementation(
    async (target: unknown, method: string, params: unknown) => {
      calls.push({ target, method, params })
      if (method !== 'terminal.resolvePane') {
        throw new Error(`the click asked the host ${method}`)
      }
      duringLookup()
      return host.answer(method, params)
    }
  )
  for (const mock of [mocks.focusRenderer, mocks.focusRuntime, mocks.toastInfo, mocks.toastError]) {
    mock.mockClear()
  }
})
afterEach(() => {
  cleanup()
  useAppStore.setState(initialStore, true)
  vi.useRealTimers()
})

/** A worker that first ran in tab-0, which this window holds, and was reopened by a follow-up
 *  in tab-1, which this window has no tab for yet. */
function reopenedWorker(first: 'live' | 'gone') {
  const firstHandle = first === 'live' ? host.open('tab-0', 'workspace') : 'term_before'
  const reopened = host.open('tab-1', 'workspace')
  publish('local', [
    { identity: 'dispatch:first', paneKey: pane('tab-1'), worktreeId: 'workspace' },
    ...(first === 'live'
      ? [{ identity: firstHandle, paneKey: pane('tab-0'), worktreeId: 'workspace' }]
      : [{ identity: firstHandle, paneKey: pane('tab-1'), worktreeId: 'workspace' }])
  ])
  return { sender: worker(firstHandle), reopened }
}

it('focuses the handle the reopened pane’s own status row holds, asking the host nothing', async () => {
  const { sender, reopened } = reopenedWorker('live')
  useAppStore.setState({
    agentStatusByPaneKey: {
      [status(0).paneKey]: status(0),
      [status(1).paneKey]: { ...status(1), terminalHandle: reopened }
    }
  })
  await open(sender)
  expect(calls).toEqual([])
  expect(mocks.focusRuntime).toHaveBeenCalledWith(reopened, null)
})

it('asks the host for the reopened pane when its status row has no handle, while the first terminal still runs', async () => {
  const { sender, reopened } = reopenedWorker('live')
  const { terminalHandle: _none, ...unhandled } = status(1)
  useAppStore.setState({
    agentStatusByPaneKey: { [status(0).paneKey]: status(0), [status(1).paneKey]: unhandled }
  })
  const resolved = resolveAgentMessageSenderTarget(
    useAppStore.getState(),
    sender,
    'workspace',
    LOCAL,
    'first'
  )
  expect(resolved.kind === 'located' && resolved.location.paneKey).toBe(pane('tab-1'))
  expect(agentMessageSenderOpens(resolved, sender)).toBe(true)
  const avatar = renderHook(() => useAgentMessageSenderView(sender, 'workspace', LOCAL, 'first'))
  expect(avatar.result.current.dot).toBe('working')
  await open(sender)
  expect(calls).toEqual([
    {
      target: LOCAL,
      method: 'terminal.resolvePane',
      params: { paneKey: pane('tab-1'), worktreeId: 'workspace' }
    }
  ])
  expect(mocks.focusRuntime).toHaveBeenCalledWith(reopened, null)
})

it('opens the reopened pane when the first terminal is gone and no status has arrived', async () => {
  const { sender, reopened } = reopenedWorker('gone')
  useAppStore.setState({ agentStatusByPaneKey: {} })
  await open(sender)
  expect(asked('orchestration.partyLocation')).toEqual([])
  expect(asked('terminal.resolvePane')).toHaveLength(1)
  expect(mocks.focusRuntime).toHaveBeenCalledWith(reopened, null)
  expect(mocks.toastInfo).not.toHaveBeenCalled()
})

it('says the worker stopped when its pane closed on the host, and opens no other terminal', async () => {
  const { sender } = reopenedWorker('live')
  useAppStore.setState({ agentStatusByPaneKey: {} })
  host.close('tab-1')
  await open(sender)
  expect(asked('terminal.resolvePane')).toHaveLength(1)
  expect(mocks.focusRuntime).not.toHaveBeenCalled()
  expect(mocks.focusRenderer).not.toHaveBeenCalled()
  expect(mocks.toastInfo).toHaveBeenCalledWith(
    'Worker is no longer running. Start a new agent from the sidebar to continue its work.'
  )
  expect(mocks.toastError).not.toHaveBeenCalled()
})

it('acts on what the card names after the host answers, not on what it named at the click', async () => {
  const { sender, reopened } = reopenedWorker('live')
  useAppStore.setState({ agentStatusByPaneKey: {} })
  // While the host answers, the worker's follow-up ends: the card names its first terminal again.
  duringLookup = () =>
    publish(
      'local',
      [{ identity: sender.party.address, paneKey: pane('tab-0'), worktreeId: 'workspace' }],
      2
    )
  await open(sender)
  expect(mocks.focusRuntime).not.toHaveBeenCalledWith(reopened, null)
  expect(useAppStore.getState().activeTabId).toBe('tab-0')
})

it('opens a held tab itself, without asking the host', async () => {
  const { sender } = reopenedWorker('live')
  useAppStore.setState({
    tabsByWorktree: {
      workspace: [
        makeTab({ id: 'tab-0', worktreeId: 'workspace' }),
        makeTab({ id: 'tab-1', worktreeId: 'workspace' })
      ]
    }
  })
  await open(sender)
  expect(useAppStore.getState().activeTabId).toBe('tab-1')
  expect(calls).toEqual([])
})

it('asks a paired host for the pane by its own coordinates, not this window’s alias for it', async () => {
  const reopened = host.open('tab-1', 'host-workspace')
  // This window mirrors the host's tab-1 under its own tab id, in another worktree bucket.
  const mirrored = toWebTerminalSurfaceTabId(`tab-1::${LEAF}`)
  useAppStore.setState({
    agentStatusByPaneKey: {},
    tabsByWorktree: {
      workspace: [
        makeTab({
          id: mirrored,
          worktreeId: 'workspace',
          ptyId: toRemoteRuntimePtyId(reopened, 'paired')
        })
      ]
    }
  })
  publish('runtime:paired', [
    { identity: 'dispatch:first', paneKey: pane('tab-1'), worktreeId: 'host-workspace' }
  ])
  const sender = worker('term_before')
  const resolved = resolveAgentMessageSenderTarget(
    useAppStore.getState(),
    sender,
    'workspace',
    PAIRED,
    'first'
  )
  expect(resolved.kind === 'located' && resolved.location.paneKey).toBe(`${mirrored}:${LEAF}`)
  await open(sender, PAIRED)
  expect(calls).toEqual([
    {
      target: PAIRED,
      method: 'terminal.resolvePane',
      params: { paneKey: pane('tab-1'), worktreeId: 'host-workspace' }
    }
  ])
  expect(mocks.focusRuntime).toHaveBeenCalledWith(reopened, 'paired')
})
