import { beforeEach, describe, expect, it, vi } from 'vitest'

type TabsByWorktree = Record<string, { contentType: string; entityId: string }[]>

const mocks = vi.hoisted(() => ({
  callRuntimeRpc: vi.fn(),
  focusRenderer: vi.fn(),
  focusRuntime: vi.fn(),
  paneUnavailable: vi.fn(),
  activateChat: vi.fn(async () => true),
  gone: vi.fn(),
  hostCannotOpen: vi.fn(),
  unavailable: vi.fn(),
  toastError: vi.fn(),
  tabs: new Map<string, TabsByWorktree>([['current', {}]])
}))

vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }))
vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  callRuntimeRpc: mocks.callRuntimeRpc,
  getActiveRuntimeTarget: ({
    activeRuntimeEnvironmentId
  }: {
    activeRuntimeEnvironmentId: string
  }) => ({ kind: 'environment', environmentId: activeRuntimeEnvironmentId })
}))
vi.mock('@/components/terminal-pane/terminal-handle-links', () => ({
  focusRendererTerminalHandle: mocks.focusRenderer,
  focusRuntimeTerminalHandle: mocks.focusRuntime
}))
vi.mock('@/components/terminal-pane/stale-agent-row', () => ({
  showAgentPaneUnavailable: mocks.paneUnavailable
}))
vi.mock('./activate-ai-vault-structured-session', () => ({
  activateAiVaultStructuredSession: mocks.activateChat,
  structuredSessionOpenFeedback: {
    gone: mocks.gone,
    hostCannotOpen: mocks.hostCannotOpen,
    unavailable: mocks.unavailable
  }
}))
vi.mock('./worktree-runtime-owner', () => ({
  getRuntimeEnvironmentIdForWorktree: () => 'env-host'
}))
vi.mock('@/store', () => ({
  useAppStore: { getState: () => ({ unifiedTabsByWorktree: mocks.tabs.get('current') }) }
}))

import { RuntimeRpcCallError } from '@/runtime/runtime-rpc-result'
import { RUNTIME_COMPAT_BLOCK_CODE } from '@/runtime/runtime-protocol-compat'
import type { AgentMessageSource } from '../../../shared/agent-session-message-source'
import { AGENT_SESSION_WRITE_NOTICE_COPY } from '../../../shared/agent-session-write-notice-copy'
import { testOrcaSessionId } from '../../../shared/orca-session-address-test-fixture'
import { openAgentMessageSender } from './open-agent-message-sender'

const HOST = { kind: 'environment', environmentId: 'env-host' }
const ROOT = testOrcaSessionId('4a1f6c2e-8b3d-4e7a-9c15-0d2b6e8f1a37')
const chat = { address: `orca_session_id:${ROOT}`, terminalHandle: null, orcaSessionId: ROOT }
const terminal = { address: 'term_a', terminalHandle: 'term_a', orcaSessionId: null }
const dispatch = { address: 'dispatch:d1', terminalHandle: 'dispatch:d1', orcaSessionId: null }

/** A notice carrying mail from each party: m1 from the terminal, m2 from someone else. */
function sourceFor(party: typeof chat | typeof terminal | typeof dispatch): AgentMessageSource {
  return {
    kind: 'agent',
    senders: [{ party, name: 'Sender' }],
    orchestration: {
      message: 'mail-notice',
      mailbox: 'run:r1',
      dispatchId: null,
      messages: [
        { messageId: 'm1', runId: 'r1', from: party.address },
        { messageId: 'm2', runId: 'r1', from: 'term_other' }
      ]
    }
  }
}

function open(party: typeof chat | typeof terminal | typeof dispatch) {
  const source = sourceFor(party)
  return openAgentMessageSender(source, source.senders[0]!, 'wt-chat')
}

function failure(code: string): RuntimeRpcCallError {
  return new RuntimeRpcCallError({
    id: 'rpc_1',
    ok: false,
    error: { code, message: code },
    _meta: { runtimeId: 'runtime_1' }
  })
}

function versionBlock(): Error {
  return Object.assign(new Error('update needed'), { code: RUNTIME_COMPAT_BLOCK_CODE })
}

// Existing sentences, each translated whole: the cause and what to do, or which Orca to update.
const UNREACHABLE = `${AGENT_SESSION_WRITE_NOTICE_COPY.unreachable} ${AGENT_SESSION_WRITE_NOTICE_COPY.tryAgain}`
const UPDATE = AGENT_SESSION_WRITE_NOTICE_COPY.updateOrcaToOpenChat
const OLDER_HOST = AGENT_SESSION_WRITE_NOTICE_COPY.unsupported

beforeEach(() => {
  vi.clearAllMocks()
  mocks.tabs.set('current', {})
})

describe("opening a message's sender", () => {
  it("asks the chat's host where a terminal is, with the mail it sent, and focuses what it finds", async () => {
    mocks.callRuntimeRpc.mockResolvedValue({ location: { kind: 'terminal', handle: 'term_now' } })
    mocks.focusRenderer.mockReturnValue(true)
    await open(terminal)
    // The stored handle may be from an earlier run; only the host knows its live one.
    expect(mocks.callRuntimeRpc).toHaveBeenCalledWith(HOST, 'orchestration.partyLocation', {
      address: 'term_a',
      messageIds: ['m1']
    })
    expect(mocks.focusRenderer).toHaveBeenCalledWith('term_now', 'env-host')
    expect(mocks.focusRuntime).not.toHaveBeenCalled()
  })

  it("opens a task's coordinator by its address alone: a task carries no mail", async () => {
    mocks.callRuntimeRpc.mockResolvedValue({ location: { kind: 'terminal', handle: 'term_now' } })
    mocks.focusRenderer.mockReturnValue(true)
    const source: AgentMessageSource = {
      kind: 'agent',
      senders: [{ party: terminal, name: 'Coordinator' }],
      orchestration: { message: 'task', runId: 'r1', taskId: 't1', dispatchId: 'd1' }
    }
    await openAgentMessageSender(source, source.senders[0]!, 'wt-chat')
    expect(mocks.callRuntimeRpc).toHaveBeenCalledWith(HOST, 'orchestration.partyLocation', {
      address: 'term_a'
    })
    expect(mocks.focusRenderer).toHaveBeenCalledWith('term_now', 'env-host')
  })

  it('says the pane is gone only when the terminal answer proves it', async () => {
    mocks.callRuntimeRpc.mockResolvedValue({ location: { kind: 'terminal', handle: 'term_a' } })
    mocks.focusRenderer.mockReturnValue(false)
    for (const code of [
      'terminal_exited',
      'terminal_gone',
      'terminal_handle_stale',
      'terminal_not_found'
    ]) {
      mocks.focusRuntime.mockRejectedValueOnce(failure(code))
      await open(terminal)
    }
    expect(mocks.paneUnavailable).toHaveBeenCalledTimes(4)
    expect(mocks.toastError).not.toHaveBeenCalled()
  })

  it("says the host could not be reached, or needs updating, when the terminal's host does not answer", async () => {
    mocks.callRuntimeRpc.mockResolvedValue({ location: { kind: 'terminal', handle: 'term_a' } })
    mocks.focusRenderer.mockReturnValue(false)
    mocks.focusRuntime.mockRejectedValueOnce(failure('request_timeout'))
    await open(terminal)
    mocks.focusRuntime.mockRejectedValueOnce(versionBlock())
    await open(terminal)
    expect(mocks.toastError.mock.calls.map(([text]) => text)).toEqual([UNREACHABLE, UPDATE])
    expect(mocks.paneUnavailable).not.toHaveBeenCalled()
    expect(mocks.unavailable).not.toHaveBeenCalled()
  })

  it('opens a chat sender at its live session through the open-chat flow', async () => {
    mocks.callRuntimeRpc.mockResolvedValue({
      location: { kind: 'chat', sessionId: 'live-session', worktreeId: 'wt-sender' }
    })
    await open(chat)
    expect(mocks.activateChat).toHaveBeenCalledWith({
      structuredSession: { workspaceId: 'wt-sender', sessionId: 'live-session' }
    })
  })

  it('names what the host lost, not how the sender was addressed', async () => {
    // A dispatch whose assignee was a chat gets the chat's words; one whose assignee was a pane, the pane's.
    mocks.callRuntimeRpc.mockResolvedValueOnce({ location: null, lost: 'chat' })
    await open(dispatch)
    mocks.callRuntimeRpc.mockResolvedValueOnce({ location: null, lost: 'terminal' })
    await open(dispatch)
    expect(mocks.gone).toHaveBeenCalledTimes(1)
    expect(mocks.paneUnavailable).toHaveBeenCalledTimes(1)
    expect(mocks.activateChat).not.toHaveBeenCalled()
  })

  it('says the host could not be reached, or needs updating, when the lookup fails, for any sender', async () => {
    mocks.callRuntimeRpc.mockRejectedValueOnce(new Error('socket closed'))
    await open(terminal)
    mocks.callRuntimeRpc.mockRejectedValueOnce(versionBlock())
    await open(chat)
    expect(mocks.toastError.mock.calls.map(([text]) => text)).toEqual([UNREACHABLE, UPDATE])
    expect(mocks.unavailable).not.toHaveBeenCalled()
    expect(mocks.gone).not.toHaveBeenCalled()
  })

  it('treats a location kind a newer host answers with as needing an update, of either side', async () => {
    mocks.callRuntimeRpc.mockResolvedValue({ location: { kind: 'browser', url: 'x' } })
    await open(terminal)
    expect(mocks.toastError).toHaveBeenCalledWith(UPDATE)
    expect(mocks.focusRenderer).not.toHaveBeenCalled()
  })

  it('on a host before the lookup, opens what this window can, else asks for an update', async () => {
    mocks.callRuntimeRpc.mockRejectedValue(failure('method_not_found'))
    mocks.tabs.set('current', { 'wt-sender': [{ contentType: 'agent-session', entityId: ROOT }] })
    await open(chat)
    expect(mocks.activateChat).toHaveBeenCalledWith({
      structuredSession: { workspaceId: 'wt-sender', sessionId: ROOT }
    })
    mocks.focusRenderer.mockReturnValue(true)
    await open(terminal)
    expect(mocks.focusRenderer).toHaveBeenCalledWith('term_a', 'env-host')
    // Only here is the chat's host known to be the older side.
    await open(dispatch)
    expect(mocks.toastError).toHaveBeenCalledWith(OLDER_HOST)
  })

  it('says it could not reach a sender the host cannot place, never that it is gone', async () => {
    mocks.callRuntimeRpc.mockResolvedValue({ location: null })
    await open(dispatch)
    expect(mocks.toastError).toHaveBeenCalledWith(UNREACHABLE)
    expect(mocks.paneUnavailable).not.toHaveBeenCalled()
    expect(mocks.gone).not.toHaveBeenCalled()
  })

  it('reports an open that throws instead of leaving it unhandled', async () => {
    mocks.callRuntimeRpc.mockResolvedValue({
      location: { kind: 'chat', sessionId: 'live-session', worktreeId: 'wt-sender' }
    })
    mocks.activateChat.mockRejectedValueOnce(new Error('store unavailable'))
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    await expect(open(chat)).resolves.toBeUndefined()
    expect(mocks.toastError).toHaveBeenCalledWith(UNREACHABLE)
    expect(warned).toHaveBeenCalled()
    warned.mockRestore()
  })

  it('runs one open per sender at a time', async () => {
    let answer: (value: unknown) => void = () => {}
    mocks.callRuntimeRpc.mockReturnValue(new Promise((resolve) => (answer = resolve)))
    const first = open(chat)
    const second = open(chat)
    answer({ location: null, lost: 'chat' })
    await Promise.all([first, second])
    expect(mocks.callRuntimeRpc).toHaveBeenCalledTimes(1)
  })
})
