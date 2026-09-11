// @vitest-environment happy-dom
//
// Two degraded panes that must never look alike: a paired host that answers and has no hold method
// still reads and still sends, it just needs an update; a host that has not answered leaves the
// pane on the transcript it last read, with writes off and a Retry.

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session-journal-types'
import { EMPTY_STRUCTURED_AGENT_SESSION } from '../../../../shared/structured-agent-session-reducer'
import type * as RuntimeRpcClientModule from '@/runtime/runtime-rpc-client'

const { mocks, moduleFactories, resetStructuredSessionMocks } = await vi.hoisted(async () =>
  (await import('./NativeChatStructuredSession.test-harness')).createStructuredSessionMocks()
)

const holdMocks = vi.hoisted(() => ({ supportsCapability: vi.fn() }))

vi.mock('@/runtime/structured-agent-session-client', () =>
  moduleFactories.structuredAgentSessionClient()
)
vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) => ({
  ...(await importOriginal<typeof RuntimeRpcClientModule>()),
  runtimeEnvironmentSupportsCapability: holdMocks.supportsCapability
}))
vi.mock('./use-native-chat-font-scale', () => moduleFactories.useNativeChatFontScale())
vi.mock('./use-native-chat-file-link-context', () => moduleFactories.useNativeChatFileLinkContext())
vi.mock('./use-native-chat-file-link-click', () => moduleFactories.useNativeChatFileLinkClick())
vi.mock('./NativeChatMessageList', () => moduleFactories.nativeChatMessageList())
vi.mock('./NativeChatComposer', () => moduleFactories.nativeChatComposer())
vi.mock('./NativeChatEmptyState', () => moduleFactories.nativeChatEmptyState())
vi.mock('./NativeChatApprovalCard', () => moduleFactories.nativeChatApprovalCard())
vi.mock('./NativeChatQuestionCard', () => moduleFactories.nativeChatQuestionCard())
vi.mock('./use-structured-agent-session-read', () => ({
  useStructuredAgentSessionRead: () => ({
    state: readState,
    loadingOlder: false,
    loadOlder: vi.fn(),
    providerSession: undefined
  })
}))

import { NativeChatStructuredSession } from './NativeChatStructuredSession'

const transcriptItem: AgentJournalRenderItem = {
  itemId: 'item-1',
  revision: 1,
  sequence: 1,
  observedAt: 1,
  body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'Last answer.' }] }
}

/** The transcript this pane already read; both degraded states must keep rendering it. */
const readState = {
  ...EMPTY_STRUCTURED_AGENT_SESSION,
  epoch: 'epoch-1',
  fence: 1,
  status: 'ready' as const,
  items: [transcriptItem]
}

function renderPairedPane(): void {
  render(
    <NativeChatStructuredSession
      isVisible
      isFocusedGroup
      tabId="tab-1"
      sessionId="session-1"
      target={{ kind: 'environment', environmentId: 'env-1' }}
      ownerPairingRevision={3}
      agent="codex"
    />
  )
}

function holdCallCount(): number {
  return mocks.call.mock.calls.filter((call) => call[1] === 'agentSession.hold').length
}

beforeEach(() => {
  holdMocks.supportsCapability.mockReset()
  mocks.call.mockImplementation(async (_target: unknown, method: string) =>
    method === 'agentSession.options'
      ? { current: { model: 'gpt-live' }, models: [], conversationCommands: [] }
      : {}
  )
})

afterEach(() => {
  cleanup()
  resetStructuredSessionMocks()
})

describe('a structured pane whose host cannot take the hold', () => {
  it('keeps a host that lacks the method readable, asks it nothing, and prompts for an update', async () => {
    holdMocks.supportsCapability.mockResolvedValue(false)

    renderPairedPane()

    const notice = await screen.findByText(/cannot reserve this session/i)
    expect(notice.dataset.nativeChatHold).toBe('unsupported')
    expect(notice.textContent).toContain(
      'The in-flight turn and its approvals survive going offline; idle sessions park after about 15 seconds and resume on demand.'
    )
    expect(screen.getByTestId('message-list')).toBeTruthy()
    // Negotiated, not speculative: the host advertised no hold, so nothing was aimed at it.
    expect(holdCallCount()).toBe(0)
    // Not an error: a host that answers still takes sends, it just does not reserve the session.
    expect(mocks.composerProps?.canSend).toBe(true)
    expect(screen.queryByRole('button', { name: /retry/i })).toBeNull()
  })

  it('leaves an unanswered host on the cached transcript with writes off and a retry', async () => {
    holdMocks.supportsCapability.mockRejectedValue(new Error('environment is not connected'))

    renderPairedPane()

    const notice = await screen.findByText(/has not answered/i)
    expect(notice.dataset.nativeChatHold).toBe('unreachable')
    expect(notice.textContent).toContain('sending is off')
    expect(screen.getByTestId('message-list')).toBeTruthy()
    await waitFor(() => expect(mocks.composerProps?.canSend).toBe(false))
    expect(screen.getByRole('button', { name: /retry/i })).toBeTruthy()
    // No wake: the pane does not aim a hold at a host it has had no answer from.
    expect(holdCallCount()).toBe(0)
  })

  it('names the lease refusal a host answered with rather than showing a live pane', async () => {
    holdMocks.supportsCapability.mockResolvedValue(true)
    mocks.call.mockImplementation(async (_target: unknown, method: string) => {
      if (method === 'agentSession.hold') {
        throw new Error('agent_session_conflict')
      }
      return method === 'agentSession.options'
        ? { current: { model: 'gpt-live' }, models: [], conversationCommands: [] }
        : {}
    })

    renderPairedPane()

    const notice = await screen.findByText(/already holds this session/i)
    expect(notice.dataset.nativeChatHold).toBe('refused')
    expect(holdCallCount()).toBe(1)
    expect(screen.getByRole('button', { name: /retry/i })).toBeTruthy()
  })
})
