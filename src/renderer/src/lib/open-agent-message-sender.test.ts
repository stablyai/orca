import { beforeEach, expect, it, vi } from 'vitest'
import type { Tab } from '../../../shared/tab-types'
import type {
  AgentMessageSource,
  AgentMessageSender
} from '../../../shared/agent-session/agent-session-message-source'

const mocks = vi.hoisted(() => {
  const unifiedTabsByWorktree: Record<string, Tab[]> = {}
  return {
    rpc: vi.fn(),
    focus: vi.fn(),
    remoteFocus: vi.fn(),
    info: vi.fn(),
    toast: vi.fn(),
    reveal: vi.fn(),
    activate: vi.fn(),
    group: vi.fn(),
    type: vi.fn(),
    state: {
      activeWorktreeId: 'wt-chat',
      activeWorkspaceExecutionHostId: 'local' as const,
      unifiedTabsByWorktree
    }
  }
})
vi.mock('sonner', () => ({ toast: { error: mocks.toast, info: mocks.info } }))
vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      ...mocks.state,
      activateTab: mocks.activate,
      focusGroup: mocks.group,
      setActiveTabType: mocks.type
    })
  }
}))
vi.mock('@/runtime/runtime-rpc-client', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  callRuntimeRpc: mocks.rpc,
  runtimeEnvironmentSupportsCapability: async () => true
}))
vi.mock('@/components/terminal-pane/terminal-handle-links', () => ({
  focusRendererTerminalHandle: mocks.focus,
  focusRuntimeTerminalHandle: mocks.remoteFocus
}))
vi.mock('./worktree-activation', () => ({ activateAndRevealWorktree: mocks.reveal }))
vi.mock('./wsl-moved-chat-activation', () => ({ activateWslMovedWorkspace: () => false }))
import { testOrcaSessionId } from '../../../shared/orca-session-address-test-fixture'
import { openAgentMessageSender } from './open-agent-message-sender'
import { RuntimeRpcCallError } from '@/runtime/runtime-rpc-result'
const host = { kind: 'environment', environmentId: 'remote-2' } as const
const ROOT = testOrcaSessionId('4a1f6c2e-8b3d-4e7a-9c15-0d2b6e8f1a37')
const party: AgentMessageSender['party'] = {
  address: 'term_worker',
  terminalHandle: 'term_worker',
  orcaSessionId: null
}
function source(p = party): AgentMessageSource {
  return {
    kind: 'agent',
    senders: [{ party: p, name: 'Worker with spaces' }],
    orchestration: {
      message: 'mail-notice',
      mailbox: 'run:r',
      dispatchId: null,
      messages: [
        { messageId: 'm1', runId: 'r', from: p.address },
        { messageId: 'other', runId: 'r', from: 'other' }
      ]
    }
  }
}
function open(p = party) {
  const s = source(p)
  return openAgentMessageSender(s, s.senders[0]!, 'wt-chat', host)
}
function tab(
  id: string,
  sessionId: string,
  owner: 'local' | 'runtime:remote-2' = 'runtime:remote-2'
): Tab {
  return {
    id,
    entityId: sessionId,
    worktreeId: 'wt-chat',
    executionHostId: owner,
    contentType: 'agent-session',
    agentSessionAgent: 'codex',
    groupId: 'g',
    label: 'Chat',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}
beforeEach(() => {
  vi.clearAllMocks()
  mocks.state.unifiedTabsByWorktree = {}
  mocks.focus.mockReturnValue(true)
  mocks.rpc.mockResolvedValue({ ok: true })
})
it('uses the receiving host and only this sender’s mail, then focuses the actual located terminal', async () => {
  mocks.rpc.mockResolvedValue({ location: { kind: 'terminal', handle: 'current' } })
  await open()
  expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith(
    host,
    'orchestration.partyLocation',
    { address: 'term_worker', messageIds: ['m1'] },
    { timeoutMs: 5000 }
  )
  expect(mocks.focus).toHaveBeenCalledWith('current', 'remote-2')
})
it.each(['method_not_found', 'forbidden'])(
  'retains direct-terminal compatibility only for %s',
  async (code) => {
    mocks.rpc.mockRejectedValue({ code })
    await open()
    expect(mocks.focus).toHaveBeenCalledWith('term_worker', 'remote-2')
  }
)
it.each(['invalid_argument', 'runtime_compat_block', 'timeout'])(
  'does not replay a terminal for %s',
  async (code) => {
    mocks.rpc.mockRejectedValue({ code })
    await open()
    expect(mocks.focus).not.toHaveBeenCalled()
    expect(mocks.toast).toHaveBeenCalledOnce()
  }
)
it.each(['dispatch:d', 'run:r'])('never focuses pseudo handle %s', async (handle) => {
  mocks.rpc.mockRejectedValue({ code: 'method_not_found' })
  await open({ address: handle, terminalHandle: handle, orcaSessionId: null })
  expect(mocks.focus).not.toHaveBeenCalled()
})
it('a known root outranks a terminal and selects only the actual owner-qualified tab/provider', async () => {
  mocks.state.unifiedTabsByWorktree = {
    'wt-chat': [tab('wrong', ROOT, 'local'), tab('actual-issued', ROOT)]
  }
  mocks.rpc.mockImplementation(async (_host, method) => {
    if (method === 'orchestration.partyLocation') {
      throw { code: 'method_not_found' }
    }
    return { ok: true }
  })
  await open({ ...party, orcaSessionId: ROOT })
  expect(mocks.activate).toHaveBeenCalledExactlyOnceWith('actual-issued', { worktreeId: 'wt-chat' })
  expect(mocks.focus).not.toHaveBeenCalled()
  expect(mocks.rpc.mock.calls.map((call) => call[1])).toEqual([
    'orchestration.partyLocation',
    'session.tabs.activate'
  ])
})
it('never guesses a missing root or falls through to its terminal', async () => {
  mocks.state.unifiedTabsByWorktree = { 'wt-chat': [tab('wrong', ROOT, 'local')] }
  mocks.rpc.mockRejectedValue({ code: 'method_not_found' })
  await open({ ...party, orcaSessionId: ROOT })
  expect(mocks.activate).not.toHaveBeenCalled()
  expect(mocks.focus).not.toHaveBeenCalled()
  expect(mocks.rpc).toHaveBeenCalledOnce()
})
it('authoritative continuation overrides the stored root and keeps the actual returned tab identity', async () => {
  mocks.state.unifiedTabsByWorktree = {
    'wt-chat': [tab('historical', ROOT), tab('actual-successor', 'successor')]
  }
  mocks.rpc.mockImplementation(async (_host, method) =>
    method === 'orchestration.partyLocation'
      ? { location: { kind: 'chat', sessionId: 'successor', worktreeId: 'wt-chat' } }
      : { ok: true }
  )
  await open({ ...party, orcaSessionId: ROOT })
  expect(mocks.activate).toHaveBeenCalledWith('actual-successor', { worktreeId: 'wt-chat' })
  expect(mocks.focus).not.toHaveBeenCalled()
})
it.each(['chat', 'terminal'] as const)('retains existing %s lost feedback', async (lost) => {
  mocks.rpc.mockResolvedValue({ location: null, lost })
  await open()
  expect(mocks.info).toHaveBeenCalledTimes(lost === 'terminal' ? 1 : 0)
  expect(mocks.toast).toHaveBeenCalledTimes(lost === 'chat' ? 1 : 0)
})
it.each([
  ['success', null],
  ...['terminal_exited', 'terminal_gone', 'terminal_handle_stale', 'terminal_not_found'].map(
    (code) => [code, 'gone'] as const
  ),
  ['request_timeout', 'retry'],
  ['runtime_compat_block', 'update']
] as const)(
  'settles runtime terminal focus for %s and permits a genuine next click',
  async (code, feedback) => {
    mocks.focus.mockReturnValue(false)
    mocks.rpc.mockResolvedValue({ location: { kind: 'terminal', handle: 'current' } })
    const focus = Promise.withResolvers<void>()
    mocks.remoteFocus.mockReturnValueOnce(focus.promise).mockResolvedValue(undefined)
    let settled = false
    const opening = open().then(() => {
      settled = true
    })
    await vi.waitFor(() =>
      expect(mocks.remoteFocus).toHaveBeenCalledExactlyOnceWith('current', 'remote-2')
    )
    expect(settled).toBe(false)
    if (feedback === null) {
      focus.resolve()
    } else if (feedback === 'update') {
      focus.reject(Object.assign(new Error('Version blocked'), { code }))
    } else {
      focus.reject(
        new RuntimeRpcCallError({
          id: 'focus',
          ok: false,
          error: { code, message: 'Focus failed' }
        })
      )
    }
    await opening
    expect(settled).toBe(true)
    if (feedback === 'gone') {
      expect(mocks.info).toHaveBeenCalledExactlyOnceWith(
        "Agent's pane is no longer available.",
        undefined
      )
    } else {
      expect(mocks.info).not.toHaveBeenCalled()
    }
    if (feedback === 'retry' || feedback === 'update') {
      expect(mocks.toast).toHaveBeenCalledExactlyOnceWith(
        feedback === 'retry'
          ? 'The structured agent session is not available yet. Retry in a moment.'
          : "This chat can't be reopened until Orca is updated."
      )
    } else {
      expect(mocks.toast).not.toHaveBeenCalled()
    }
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith(
      host,
      'orchestration.partyLocation',
      { address: 'term_worker', messageIds: ['m1'] },
      { timeoutMs: 5000 }
    )
    expect(mocks.focus).toHaveBeenCalledExactlyOnceWith('current', 'remote-2')
    for (const mutation of [mocks.activate, mocks.group, mocks.type, mocks.reveal]) {
      expect(mutation).not.toHaveBeenCalled()
    }
    const errors = mocks.toast.mock.calls.length
    const infos = mocks.info.mock.calls.length
    await open()
    expect(mocks.rpc).toHaveBeenCalledTimes(2)
    expect(mocks.remoteFocus).toHaveBeenNthCalledWith(2, 'current', 'remote-2')
    expect(mocks.toast).toHaveBeenCalledTimes(errors)
    expect(mocks.info).toHaveBeenCalledTimes(infos)
  }
)
it('coalesces one sender but keeps selected hosts independent', async () => {
  const wait = Promise.withResolvers<unknown>()
  mocks.rpc.mockReturnValue(wait.promise)
  const a = open(),
    b = open()
  const s = source()
  const c = openAgentMessageSender(s, s.senders[0]!, 'wt-chat', { kind: 'local' })
  expect(mocks.rpc).toHaveBeenCalledTimes(2)
  wait.resolve({ location: null })
  await Promise.all([a, b, c])
  expect(mocks.toast).toHaveBeenCalledTimes(2)
})
