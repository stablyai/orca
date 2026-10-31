// @vitest-environment happy-dom
import { cleanup } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createTabsSliceMockApi } from '../store/slices/tabs-slice-test-harness'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import type * as SessionOwner from '@/runtime/structured-agent-session-owner'
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
    consent: vi.fn(async () => false),
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
vi.mock('@/runtime/structured-agent-session-switch-consent', () => ({
  supportsSwitchConsent: mocks.consent
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
vi.mock('./conversation-switch-focus-intent', () => ({
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
  mocks.consent.mockResolvedValue(false)
  mocks.call.mockResolvedValue({ status: 'completed', sessionId: subject.sessionId })
  useAppStore.setState(useAppStore.getInitialState(), true)
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  pendingNativeChatCliSwitches.clear()
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
        options: { beforeSend: (sentAt?: number) => void }
      ) => {
        if (sent) {
          options.beforeSend()
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

it.each([
  ['confirms', true],
  ['cancels', false]
])(
  'asks only when a host that decides consent refuses a replying agent, and the user %s',
  async (_name, confirmed) => {
    mocks.consent.mockResolvedValue(true)
    const confirm = vi.fn(async () => confirmed)
    mocks.call
      .mockResolvedValueOnce({
        status: 'refused',
        sessionId: subject.sessionId,
        refusal: { code: 'agent_session_operation_invalid', details: { reason: 'turnActive' } }
      })
      .mockResolvedValueOnce({ status: 'completed', sessionId: subject.sessionId })
    await expect(runConversationSwitch({ ...subject, confirm })).resolves.toBe(confirmed)
    expect(confirm).toHaveBeenCalledOnce()
    const executions = mocks.call.mock.calls.map(([, , params]) => params.execution)
    expect(executions[0]).toMatchObject({ consented: false })
    if (confirmed) {
      // A yes is a fresh switch, never a replay of the refused invocation.
      expect(executions[1]).toMatchObject({ consented: true })
      expect(executions[1].invocationId).not.toBe(executions[0].invocationId)
    } else {
      expect(mocks.call).toHaveBeenCalledOnce()
    }
    expect(mocks.error).not.toHaveBeenCalled()
  }
)

it('sends no consent field to a host that does not decide consent (its strict schema)', async () => {
  await expect(runConversationSwitch(subject)).resolves.toBe(true)
  expect(mocks.call.mock.calls[0]![2].execution).not.toHaveProperty('consented')
})

const fromPane = {
  tabId: 'terminal',
  workspaceId: 'workspace',
  paneKey: 'terminal:leaf',
  agent: 'codex' as const,
  providerSessionId: 'codex-session',
  executionHostId: 'local' as const,
  ptyId: 'pty'
}
it.each([
  ['refuses', 'refused', true],
  ['asks for consent and the user declines', 'declined', true],
  ['fails before the request is sent', 'unsent', true],
  ['loses the answer after the send', 'lost', false]
] as const)(
  'withdraws where a split switch would land when the host %s',
  async (_name, outcome, withdrawn) => {
    mocks.consent.mockResolvedValue(outcome === 'declined')
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
        options: { beforeSend: (sentAt?: number) => void }
      ) => {
        if (outcome === 'unsent') {
          throw new Error('Remote Orca runtime is not connected.')
        }
        options.beforeSend()
        if (outcome === 'lost') {
          throw new Error('Runtime request closed before agentSession.switchToChat completed')
        }
        return {
          status: 'refused',
          sessionId: 'chat',
          refusal: {
            code: 'agent_session_operation_invalid',
            details: { reason: outcome === 'declined' ? 'turnActive' : 'messagesUnsettled' }
          }
        }
      }
    )
    const confirm = vi.fn(async () => false)
    await expect(
      runConversationSwitch({ direction: 'chat', ...fromPane, source: fromPane, confirm })
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

it('opens the conversation from History beside a stopped paired pane it can no longer capture', async () => {
  // A failed switch stopped the pane on a paired host; its binding is gone, so it can't be captured.
  mocks.target.current = { kind: 'environment', environmentId: 'paired' }
  mocks.capture.mockResolvedValue(null)
  mocks.prepare.mockResolvedValue({ sessionId: 'codex-session' })
  mocks.call.mockResolvedValue({ status: 'completed', sessionId: 'chat' })
  const history = makeTabSessionHistoryRow({ agent: 'codex', sessionId: 'codex-session' })
  await expect(
    runConversationSwitch({ direction: 'chat', ...fromPane, source: fromPane, history })
  ).resolves.toBe(true)
  expect(mocks.prepare).toHaveBeenCalledWith(history)
  const [, method, params] = mocks.call.mock.calls[0]!
  expect(method).toBe('agentSession.switchToChat')
  expect(params.execution).toMatchObject({ create: expect.any(Object) })
  expect(params.execution).not.toHaveProperty('source')
  expect(mocks.error).not.toHaveBeenCalled()
  // Without History's conversation, the pane's own controls still say it can't switch.
  mocks.call.mockClear()
  await expect(
    runConversationSwitch({ direction: 'chat', ...fromPane, source: fromPane })
  ).resolves.toBe(false)
  expect(mocks.call).not.toHaveBeenCalled()
})
