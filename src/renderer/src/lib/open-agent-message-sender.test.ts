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
import { openAgentMessageSender } from './open-agent-message-sender'
import { RuntimeRpcCallError } from '@/runtime/runtime-rpc-result'
const host = { kind: 'environment', environmentId: 'remote-2' } as const
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
beforeEach(() => {
  vi.clearAllMocks()
  mocks.state.unifiedTabsByWorktree = {}
  mocks.focus.mockReturnValue(true)
  mocks.rpc.mockResolvedValue({ ok: true })
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
