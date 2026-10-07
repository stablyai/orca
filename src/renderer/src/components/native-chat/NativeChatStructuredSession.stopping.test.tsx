// @vitest-environment happy-dom

import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionStatusEvent } from '../../../../shared/agent-session-wire'

const { mocks, moduleFactories, resetStructuredSessionMocks } = await vi.hoisted(async () =>
  (await import('./NativeChatStructuredSession.test-harness')).createStructuredSessionMocks()
)
const hostStatus = vi.hoisted((): { emit: ((event: AgentSessionStatusEvent) => void) | null } => ({
  emit: null
}))

vi.mock('@/runtime/structured-agent-session-client', () => ({
  ...moduleFactories.structuredAgentSessionClient(),
  subscribeStructuredAgentSessionStatus: async (
    _target: unknown,
    onEvent: (event: AgentSessionStatusEvent) => void
  ) => {
    hostStatus.emit = onEvent
    return { unsubscribe: () => {} }
  }
}))
vi.mock('./use-structured-agent-session', () => moduleFactories.useStructuredAgentSession())
vi.mock('./use-native-chat-font-size', () => moduleFactories.useNativeChatFontSize())
vi.mock('./use-native-chat-file-link-context', () => moduleFactories.useNativeChatFileLinkContext())
vi.mock('./use-native-chat-file-link-click', () => moduleFactories.useNativeChatFileLinkClick())
vi.mock('./NativeChatMessageList', () => moduleFactories.nativeChatMessageList())
vi.mock('./NativeChatComposer', () => moduleFactories.nativeChatComposer())
vi.mock('./NativeChatEmptyState', () => moduleFactories.nativeChatEmptyState())
vi.mock('./NativeChatApprovalCard', () => moduleFactories.nativeChatApprovalCard())
vi.mock('./NativeChatQuestionCard', () => moduleFactories.nativeChatQuestionCard())

import { TooltipProvider } from '@/components/ui/tooltip'
import { NativeChatStructuredSession } from './NativeChatStructuredSession'

function renderPane(): void {
  render(
    <TooltipProvider>
      <NativeChatStructuredSession
        isVisible
        isFocusedGroup
        tabId="structured-tab-1"
        sessionId="session-1"
        target={{ kind: 'local' }}
        agent="codex"
      />
    </TooltipProvider>
  )
}

/** The host's summary for the pane's session, as its status feed publishes it. */
function hostSays(stopping: boolean): void {
  act(() =>
    hostStatus.emit?.({
      type: 'status',
      session: {
        sessionId: 'session-1',
        workspaceId: 'wt-1',
        agent: 'codex',
        status: 'working',
        latestPrompt: 'work on this',
        updatedAt: Date.now(),
        ...(stopping ? { stopping: true as const } : {})
      }
    })
  )
}

describe("the chat pane while a person's Stop ends the turn", () => {
  afterEach(() => {
    hostSays(false)
    cleanup()
    resetStructuredSessionMocks()
  })

  it("reads Stopping from the host's word and keeps Stop for the repeat that escalates", async () => {
    mocks.turnId = 'turn-1'
    mocks.isWorking = true
    renderPane()
    await waitFor(() => expect(hostStatus.emit).not.toBeNull())
    expect(mocks.composerProps).toMatchObject({ isWorking: true, isStopping: false })

    hostSays(true)

    // A Stop the provider took and never answered (a Codex command) ends only at a second Stop.
    await waitFor(() => expect(mocks.messageListProps).toMatchObject({ stopping: true }))
    // The queue is dark here: the message is sent, and the host holds it until the stop lands.
    expect(mocks.composerProps).toMatchObject({ isStopping: false, afterStop: 'send' })
    // Nothing steers into a turn a Stop is ending.
    expect(mocks.composerProps?.steerQueued).toBeUndefined()
    mocks.composerProps?.onStop?.()
    expect(mocks.stop).toHaveBeenCalledOnce()
  })

  it('tells the composer a send while Stopping becomes a card where the host queues sends', async () => {
    mocks.turnId = 'turn-1'
    mocks.sendsQueue = true
    renderPane()
    await waitFor(() => expect(hostStatus.emit).not.toBeNull())

    hostSays(true)

    await waitFor(() => expect(mocks.composerProps).toMatchObject({ afterStop: 'queue' }))
  })

  it("holds a queued card's Steer while the host says Stopping", async () => {
    mocks.turnId = 'turn-1'
    mocks.queuedCards = [
      { messageId: 'draft-1', position: 1, text: 'one more thing', state: 'waiting', hold: 'turn' }
    ]
    renderPane()
    await waitFor(() => expect(hostStatus.emit).not.toBeNull())
    const steer = (): HTMLElement | null =>
      document.querySelector('[data-queued-message-id="draft-1"] button')
    expect(steer()).toHaveProperty('disabled', false)

    hostSays(true)

    await waitFor(() => expect(steer()).toHaveProperty('disabled', true))
  })

  it('reads Stopping from its own press, and holds Stop until that request answers', () => {
    mocks.turnId = 'turn-1'
    mocks.stopPressed = true
    renderPane()

    expect(mocks.composerProps).toMatchObject({ isStopping: true })
    expect(mocks.messageListProps).toMatchObject({ stopping: true })
    mocks.composerProps?.onStop?.()
    expect(mocks.stop).not.toHaveBeenCalled()
  })

  it('stops normally while nothing is stopping', () => {
    mocks.turnId = 'turn-1'
    renderPane()

    expect(mocks.composerProps).toMatchObject({ isStopping: false })
    expect(mocks.composerProps?.afterStop).toBeUndefined()
    // The pane wraps steering so it also brings the latest into view; it still steers through the queue.
    mocks.composerProps?.steerQueued?.()
    expect(mocks.queuedSteerNewest).toHaveBeenCalledOnce()
    mocks.composerProps?.onStop?.()
    expect(mocks.stop).toHaveBeenCalledOnce()
  })

  it('reads nothing once the chat has nothing left to stop', async () => {
    renderPane()
    await waitFor(() => expect(hostStatus.emit).not.toBeNull())

    hostSays(true)

    expect(mocks.composerProps).toMatchObject({ isStopping: false })
    expect(mocks.messageListProps).toMatchObject({ stopping: false })
  })
})
