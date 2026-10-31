// @vitest-environment happy-dom
import { cleanup } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createTabsSliceMockApi } from '../store/slices/tabs-slice-test-harness'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import type * as SessionOwner from '@/runtime/structured-agent-session-owner'
import type * as FocusIntent from './conversation-switch-focus-intent'
import {
  peekWebSessionFocusIntent,
  resetWebSessionFocusIntentForTests
} from '@/runtime/web-session-focus-intent'
import { useAppStore } from '@/store'
import { runConversationSwitch } from './conversation-surface-switch'
import { pendingNativeChatCliSwitches } from './pending-conversation-surface-switches'
import { makeTabSessionHistoryRow } from '@/components/tab-bar/tab-session-history-test-fixture'
const mocks = vi.hoisted(() => {
  function makeTarget(): { current: RuntimeClientTarget } {
    return { current: { kind: 'local' } }
  }
  return {
    target: makeTarget(),
    support: vi.fn(),
    rpc: vi.fn(),
    capture: vi.fn(),
    prepare: vi.fn(),
    pairedRefresh: vi.fn(),
    call: vi.fn(),
    legacy: vi.fn(async () => {}),
    abandonFocus: vi.fn(),
    refresh: vi.fn(async () => {}),
    error: vi.fn(),
    info: vi.fn(),
    reader: vi.fn(),
    listeners: new Set<() => void>(),
    subscribe: (listener: () => void) => {
      mocks.listeners.add(listener)
      return () => mocks.listeners.delete(listener)
    }
  }
})
vi.mock('sonner', () => ({ toast: { error: mocks.error, info: mocks.info } }))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  supportsInPlaceSwitch: mocks.support,
  callStructuredAgentSession: mocks.call
}))
vi.mock('@/runtime/structured-agent-session-owner', async (original) => ({
  ...(await original<typeof SessionOwner>()),
  structuredAgentSessionTargetForHost: () => mocks.target.current
}))
vi.mock('@/runtime/runtime-rpc-client', async (original) => ({
  ...(await original<object>()),
  callRuntimeRpc: mocks.rpc
}))
vi.mock('@/components/tab-bar/cli-chat-resume-terminal-capture', () => ({
  captureSourceTerminal: mocks.capture
}))
vi.mock('./conversation-switch-focus-intent', async (original) => ({
  ...(await original<typeof FocusIntent>()),
  recordConversationSwitchFocus: () => mocks.abandonFocus
}))
vi.mock('./ai-vault-session-resume-preparation', () => ({
  prepareAiVaultSessionForResume: mocks.prepare
}))
vi.mock('@/runtime/web-runtime-session-snapshot', () => ({
  refreshWebRuntimeSessionTabsSnapshot: mocks.pairedRefresh
}))
vi.mock('./in-place-switch-support', () => ({
  useInPlaceSwitchCapability: () => true
}))
vi.mock('@/runtime/structured-agent-session-status-feed', () => ({
  getStructuredAgentSessionStatusFeed: () => ({
    subscribe: mocks.subscribe,
    getSnapshot: () => new Map()
  })
}))
vi.mock('@/components/native-chat/structured-agent-session-read-owner-registry', () => ({
  findStructuredAgentSessionReadOwner: mocks.reader
}))
vi.mock('@/components/tab-bar/cli-chat-resume-run', () => ({
  runLegacyCliChatResume: mocks.legacy
}))
vi.mock('@/components/tab-bar/cli-chat-resume-feedback', () => ({
  switchIntoOwnerLegacy: mocks.legacy
}))
vi.mock('@/runtime/local-structured-session-tabs-sync/inventory-refresh', () => ({
  refreshLocalStructuredSessionWorktreeTabs: mocks.refresh
}))
vi.mock('@/components/right-sidebar/ai-vault-session-resume-in-chat-launch', () => ({
  resumeAiVaultSessionInNewChat: mocks.legacy,
  adoptingAgentOnHost: async (agent: string) => agent
}))

const subject = {
  direction: 'terminal' as const,
  executionHostId: 'local',
  workspaceId: 'workspace',
  sessionId: 'codex_chat',
  agent: 'codex' as const,
  chatTabId: 'source'
}
beforeEach(() => {
  vi.clearAllMocks()
  createTabsSliceMockApi()
  mocks.target.current = { kind: 'local' }
  mocks.rpc.mockResolvedValue({})
  mocks.pairedRefresh.mockResolvedValue(undefined)
  mocks.capture.mockResolvedValue({
    handle: 'terminal-source',
    incarnationId: 'incarnation',
    presentation: {}
  })
  mocks.reader.mockReturnValue(undefined)
  mocks.support.mockResolvedValue(true)
  mocks.call.mockResolvedValue({ status: 'completed', sessionId: subject.sessionId })
  useAppStore.setState(useAppStore.getInitialState(), true)
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  pendingNativeChatCliSwitches.clear()
  resetWebSessionFocusIntentForTests()
})

it('sends one switch, shows pending only while the host runs it, and settles without a message', async () => {
  mocks.support.mockResolvedValue(true)
  let pendingDuringCall = false
  mocks.call.mockImplementation(async () => {
    pendingDuringCall = pendingNativeChatCliSwitches.size > 0
    return { status: 'completed', sessionId: subject.sessionId }
  })
  await expect(runConversationSwitch(subject)).resolves.toBe(true)
  expect(pendingDuringCall).toBe(true)
  expect(pendingNativeChatCliSwitches.size).toBe(0)
  const [, method, params] = mocks.call.mock.calls[0]!
  expect(method).toBe('agentSession.switchToTerminal')
  expect(params).toMatchObject({
    sessionId: subject.sessionId,
    execution: { invocationId: expect.any(String), sourceTabId: 'source' }
  })
  expect(mocks.error).not.toHaveBeenCalled()
  expect(mocks.info).not.toHaveBeenCalled()
})

it('reports a refused switch once and leaves nothing pending', async () => {
  mocks.support.mockResolvedValue(true)
  mocks.call.mockResolvedValue({
    status: 'refused',
    sessionId: subject.sessionId,
    refusal: { code: 'agent_session_operation_invalid', details: { reason: 'messagesUnsettled' } }
  })
  await expect(runConversationSwitch(subject)).resolves.toBe(false)
  expect(mocks.error).toHaveBeenCalledOnce()
  expect(pendingNativeChatCliSwitches.size).toBe(0)
  // A second click is a fresh switch, never swallowed by a stale pending entry.
  mocks.call.mockResolvedValue({ status: 'completed', sessionId: subject.sessionId })
  await expect(runConversationSwitch(subject)).resolves.toBe(true)
})

it('keeps the earlier chat resume where the agent or host has no in-place switch', async () => {
  mocks.support.mockResolvedValue(false)
  const source = {
    tabId: 'terminal',
    workspaceId: 'workspace',
    paneKey: 'terminal:leaf',
    agent: 'omp' as const,
    providerSessionId: 'omp-session',
    executionHostId: 'local' as const,
    ptyId: 'pty'
  }
  await expect(
    runConversationSwitch({ direction: 'chat', ...source, source, agent: 'omp' })
  ).resolves.toBe(false)
  expect(mocks.legacy).toHaveBeenCalledWith(source, expect.any(Function))
  expect(mocks.call).not.toHaveBeenCalled()
})

it('stops nothing when a chat switch races a host that cannot switch in place', async () => {
  mocks.support.mockResolvedValue(false)
  await expect(runConversationSwitch(subject)).resolves.toBe(false)
  expect(mocks.legacy).not.toHaveBeenCalled()
  expect(mocks.call).not.toHaveBeenCalled()
  expect(mocks.error).toHaveBeenCalledOnce()
})

it.each([false, true])(
  'reads a lost answer once the request left (sent=%s) as unconfirmed, never as a setup problem',
  async (sent) => {
    mocks.call.mockImplementation(
      async (
        _target: unknown,
        _method: string,
        _params: unknown,
        options: { onSent: (sentAt?: number) => void }
      ) => {
        if (sent) {
          options.onSent()
        }
        throw new Error('Runtime request closed before agentSession.switchToTerminal completed')
      }
    )
    await expect(runConversationSwitch(subject)).resolves.toBe(false)
    expect(mocks.error).toHaveBeenCalledExactlyOnceWith(
      sent
        ? 'Orca could not confirm the Codex switch. Check the open chat and terminal before trying again.'
        : 'Codex could not switch to a terminal. Try again.'
    )
  }
)

const fromPane = {
  tabId: 'terminal',
  workspaceId: 'workspace',
  paneKey: 'terminal:leaf',
  agent: 'codex' as const,
  providerSessionId: 'codex-session',
  executionHostId: 'local' as const,
  ptyId: 'pty'
}

// A replying agent: a host that asked before stopping a reply refuses only when told `false`.
async function replyingHost(
  _target: unknown,
  _method: string,
  params: { sessionId: string; execution: { consented?: boolean } }
) {
  return params.execution.consented === false
    ? {
        status: 'refused',
        sessionId: params.sessionId,
        refusal: { code: 'agent_session_operation_invalid', details: { reason: 'turnActive' } }
      }
    : { status: 'completed', sessionId: params.sessionId }
}

it.each([
  ['terminal', 'claude'],
  ['terminal', 'codex'],
  ['chat', 'claude'],
  ['chat', 'codex']
] as const)(
  'switches a replying agent to %s without asking (%s), sending no consent',
  async (direction, agent) => {
    mocks.call.mockImplementation(replyingHost)
    mocks.capture.mockResolvedValue({
      target: { kind: 'local' },
      handle: 'terminal-source',
      incarnationId: 'incarnation',
      presentation: { identity: { tabId: 'terminal' }, holders: [] }
    })
    const pane = { ...fromPane, agent, providerSessionId: `${agent}-session` }
    const args =
      direction === 'chat'
        ? { direction, ...pane, source: pane }
        : { ...subject, agent, sessionId: `${agent}_chat` }
    await expect(runConversationSwitch(args)).resolves.toBe(true)
    expect(mocks.call).toHaveBeenCalledOnce()
    expect(mocks.call.mock.calls[0]![2].execution).not.toHaveProperty('consented')
    expect(mocks.error).not.toHaveBeenCalled()
  }
)

it('shows a host’s refusal of a replying agent once, without retrying', async () => {
  mocks.call.mockResolvedValue({
    status: 'refused',
    sessionId: subject.sessionId,
    refusal: { code: 'agent_session_operation_invalid', details: { reason: 'turnActive' } }
  })
  await expect(runConversationSwitch(subject)).resolves.toBe(false)
  expect(mocks.call).toHaveBeenCalledOnce()
  expect(mocks.error).toHaveBeenCalledOnce()
})

it.each([
  ['terminal', undefined],
  ['chat', undefined],
  ['terminal', { sessionId: 'owner-chat', workspaceId: 'workspace' }]
] as const)(
  'names the agent open elsewhere when another holder refuses a switch to %s (owner %o)',
  async (direction, owner) => {
    mocks.call.mockResolvedValue({
      status: 'refused',
      sessionId: subject.sessionId,
      refusal: {
        code: 'agent_session_conflict',
        details: { reason: 'conversationHeldElsewhere', ...(owner ? { owner } : {}) }
      }
    })
    mocks.capture.mockResolvedValue({
      target: { kind: 'local' },
      handle: 'terminal-source',
      incarnationId: 'incarnation',
      presentation: { identity: { tabId: 'terminal' }, holders: [] }
    })
    const args = direction === 'chat' ? { direction, ...fromPane, source: fromPane } : subject
    await expect(runConversationSwitch(args)).resolves.toBe(false)
    expect(mocks.error).toHaveBeenCalledExactlyOnceWith(
      'Codex is open in another chat or terminal. Continue there, then try switching again.'
    )
  }
)

it.each([
  ['refuses', 'refused', true],
  ['fails before the request is sent', 'unsent', true],
  ['loses the answer after the send', 'lost', false]
] as const)(
  'withdraws where a split switch would land when the host %s',
  async (_name, outcome, withdrawn) => {
    mocks.capture.mockResolvedValue({
      target: { kind: 'environment', environmentId: 'paired' },
      handle: 'terminal-source',
      incarnationId: 'incarnation',
      presentation: { identity: { tabId: 'host-terminal' }, holders: [] }
    })
    mocks.call.mockImplementation(
      async (
        _target: unknown,
        _method: string,
        _params: unknown,
        options: { onSent: (sentAt?: number) => void }
      ) => {
        if (outcome === 'unsent') {
          throw new Error('Remote Orca runtime is not connected.')
        }
        options.onSent()
        if (outcome === 'lost') {
          throw new Error('Runtime request closed before agentSession.switchToChat completed')
        }
        return {
          status: 'refused',
          sessionId: 'chat',
          refusal: {
            code: 'agent_session_operation_invalid',
            details: { reason: 'messagesUnsettled' }
          }
        }
      }
    )
    await expect(
      runConversationSwitch({ direction: 'chat', ...fromPane, source: fromPane })
    ).resolves.toBe(false)
    expect(mocks.call).toHaveBeenCalledOnce()
    expect(mocks.abandonFocus).toHaveBeenCalledTimes(withdrawn ? 1 : 0)
  }
)

it.each([
  ['terminal', 'Codex could not switch to a terminal. Try again.'],
  ['chat', 'Codex could not switch to chat. Use Switch to Chat UI to try again.']
] as const)(
  'runs nothing when the host could not be asked whether it switches (to %s)',
  async (direction, text) => {
    // A dropped connection while the capability is re-read: not an older host.
    mocks.support.mockRejectedValue(new Error('Remote Orca runtime is not connected.'))
    const args =
      direction === 'chat'
        ? { direction, ...fromPane, source: fromPane }
        : { ...subject, direction }
    await expect(runConversationSwitch(args)).resolves.toBe(false)
    expect(mocks.call).not.toHaveBeenCalled()
    expect(mocks.legacy).not.toHaveBeenCalled()
    expect(mocks.error).toHaveBeenCalledExactlyOnceWith(text)
  }
)

it.each([true, false])(
  'opens the conversation beside a paired pane it can no longer capture (from History=%s)',
  async (fromHistory) => {
    // The pane's shell exited, or a failed switch stopped it: its binding is gone, so the pane
    // can't be captured, and nothing is left in it to stop.
    mocks.target.current = { kind: 'environment', environmentId: 'paired' }
    mocks.capture.mockResolvedValue(null)
    mocks.prepare.mockResolvedValue({ sessionId: 'history-session' })
    mocks.call.mockResolvedValue({ status: 'completed', sessionId: 'chat' })
    const history = makeTabSessionHistoryRow({ agent: 'codex', sessionId: 'history-session' })
    await expect(
      runConversationSwitch({
        direction: 'chat',
        ...fromPane,
        source: fromPane,
        ...(fromHistory ? { history } : {})
      })
    ).resolves.toBe(true)
    expect(mocks.prepare).toHaveBeenCalledTimes(fromHistory ? 1 : 0)
    const [, method, params] = mocks.call.mock.calls[0]!
    expect(method).toBe('agentSession.switchToChat')
    expect(params.execution.create.resumeFrom).toEqual(
      fromHistory
        ? { providerSessionId: 'history-session' }
        : {
            providerSessionId: fromPane.providerSessionId,
            cliSource: { workspaceId: fromPane.workspaceId, paneKey: fromPane.paneKey }
          }
    )
    expect(params.execution).not.toHaveProperty('source')
    // The chat this user asked for lands selected here, right after the pane's tab.
    expect(params.execution.sourceTabId).toBe('terminal')
    expect(peekWebSessionFocusIntent({ environmentId: 'paired' }, 'workspace')).toMatchObject({
      hostTabId: `agent-session:${params.sessionId}`,
      afterHostTabId: 'terminal'
    })
    expect(mocks.error).not.toHaveBeenCalled()
  }
)

it('opens a History chat with no pane selected, at the end, and withdraws that on a refusal', async () => {
  mocks.target.current = { kind: 'environment', environmentId: 'paired' }
  mocks.prepare.mockResolvedValue({ sessionId: 'history-session' })
  mocks.call.mockResolvedValue({ status: 'completed', sessionId: 'chat' })
  const history = makeTabSessionHistoryRow({ agent: 'codex', sessionId: 'history-session' })
  const args = { ...fromPane, direction: 'chat' as const, history }
  await expect(runConversationSwitch(args)).resolves.toBe(true)
  const [, , params] = mocks.call.mock.calls[0]!
  expect(params.execution).not.toHaveProperty('sourceTabId')
  expect(peekWebSessionFocusIntent({ environmentId: 'paired' }, 'workspace')).toEqual(
    expect.objectContaining({ hostTabId: `agent-session:${params.sessionId}` })
  )
  mocks.call.mockResolvedValue({
    status: 'refused',
    sessionId: 'chat',
    refusal: { code: 'agent_session_operation_invalid', details: { reason: 'messagesUnsettled' } }
  })
  await expect(runConversationSwitch(args)).resolves.toBe(false)
  expect(peekWebSessionFocusIntent({ environmentId: 'paired' }, 'workspace')).toBeNull()
})

it('opens a History conversation’s existing chat selected, right after the pane it came from', async () => {
  // The chat exists but is closed or not shown here, and the pane can't be captured: the host
  // reopens that chat, and this client selects it as it would a new one.
  mocks.target.current = { kind: 'environment', environmentId: 'paired' }
  mocks.capture.mockResolvedValue(null)
  mocks.call.mockResolvedValue({ status: 'completed', sessionId: 'existing-chat' })
  const history = makeTabSessionHistoryRow({ agent: 'codex', sessionId: 'history-session' })
  await expect(
    runConversationSwitch({
      direction: 'chat',
      ...fromPane,
      source: fromPane,
      history,
      sessionId: 'existing-chat'
    })
  ).resolves.toBe(true)
  const [, method, params] = mocks.call.mock.calls[0]!
  expect(method).toBe('agentSession.switchToChat')
  expect(params.sessionId).toBe('existing-chat')
  expect(params.execution).not.toHaveProperty('create')
  expect(params.execution.sourceTabId).toBe('terminal')
  expect(peekWebSessionFocusIntent({ environmentId: 'paired' }, 'workspace')).toMatchObject({
    hostTabId: 'agent-session:existing-chat',
    afterHostTabId: 'terminal'
  })
})
