// @vitest-environment happy-dom

import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentSessionStatusEvent,
  AgentSessionStatusSummary
} from '../../../../shared/agent-session-wire'

const { mocks, moduleFactories, resetStructuredSessionMocks } = await vi.hoisted(async () =>
  (await import('./NativeChatStructuredSession.test-harness')).createStructuredSessionMocks()
)
const statusFeed = vi.hoisted(() => ({
  subscribe: vi.fn<
    (
      target: unknown,
      onEvent: (event: AgentSessionStatusEvent) => void
    ) => Promise<{
      unsubscribe: () => void
    }>
  >(async () => ({ unsubscribe: () => {} }))
}))

vi.mock('@/lib/structured-agent-session-launch', () =>
  moduleFactories.structuredAgentSessionLaunch()
)
vi.mock('@/runtime/structured-agent-session-client', () => ({
  ...moduleFactories.structuredAgentSessionClient(),
  subscribeStructuredAgentSessionStatus: statusFeed.subscribe
}))
vi.mock('./use-structured-agent-session', () => moduleFactories.useStructuredAgentSession())
vi.mock('./use-native-chat-font-scale', () => moduleFactories.useNativeChatFontScale())
vi.mock('./use-native-chat-file-link-context', () => moduleFactories.useNativeChatFileLinkContext())
vi.mock('./use-native-chat-file-link-click', () => moduleFactories.useNativeChatFileLinkClick())
vi.mock('./NativeChatMessageList', () => moduleFactories.nativeChatMessageList())
vi.mock('./NativeChatComposer', () => moduleFactories.nativeChatComposer())
vi.mock('./NativeChatEmptyState', () => moduleFactories.nativeChatEmptyState())
vi.mock('./NativeChatApprovalCard', () => moduleFactories.nativeChatApprovalCard())
vi.mock('./NativeChatQuestionCard', () => moduleFactories.nativeChatQuestionCard())

import { NativeChatStructuredSession } from './NativeChatStructuredSession'
import { resetStructuredAgentSessionStatusFeedsForTests } from '@/runtime/structured-agent-session-status-feed'

function summary(phase: 'starting' | 'ready'): AgentSessionStatusSummary {
  return {
    sessionId: 'session-1',
    workspaceId: 'wt-1',
    agent: 'claude',
    status: 'working',
    hostExecutionOwned: true,
    hostExecutionPhase: phase,
    latestPrompt: 'Fix the build',
    updatedAt: 1
  }
}

function emit(event: AgentSessionStatusEvent): void {
  const onEvent = statusFeed.subscribe.mock.calls[0]?.[1]
  if (!onEvent) {
    throw new Error('status feed not subscribed')
  }
  act(() => onEvent(event))
}

describe('NativeChatStructuredSession while the agent starts', () => {
  beforeEach(() => {
    resetStructuredSessionMocks()
    resetStructuredAgentSessionStatusFeedsForTests()
    statusFeed.subscribe.mockClear()
  })
  afterEach(cleanup)

  it("follows the host's startup phase on the working indicator", async () => {
    mocks.isWorking = true
    render(
      <NativeChatStructuredSession
        isVisible
        isFocusedGroup
        tabId="structured-tab-1"
        sessionId="session-1"
        target={{ kind: 'local' }}
        agent="claude"
      />
    )
    await waitFor(() => expect(statusFeed.subscribe).toHaveBeenCalledOnce())
    expect(mocks.messageListProps?.agentStarting).toBe(false)

    emit({ type: 'status', session: summary('starting') })
    expect(mocks.messageListProps?.agentStarting).toBe(true)

    emit({ type: 'status', session: summary('ready') })
    expect(mocks.messageListProps?.agentStarting).toBe(false)
  })
})
