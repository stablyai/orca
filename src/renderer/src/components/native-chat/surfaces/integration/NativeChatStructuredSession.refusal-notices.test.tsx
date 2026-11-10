// @vitest-environment happy-dom

import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { StructuredAgentSessionCommandRefusalCause } from '../../../../../../shared/agent-session/view/structured-agent-session-composer'
import { NativeChatStructuredSession } from '../../NativeChatStructuredSession'

const { mocks, moduleFactories, resetStructuredSessionMocks } = await vi.hoisted(async () =>
  (await import('./NativeChatStructuredSession.test-harness')).createStructuredSessionMocks()
)

vi.mock('../../../../runtime/native-chat/requests/structured-agent-session-call', () =>
  moduleFactories.structuredAgentSessionCall()
)
vi.mock('../../../../runtime/native-chat/requests/structured-agent-session-subscriptions', () =>
  moduleFactories.structuredAgentSessionSubscriptions()
)
vi.mock('../../session/structured/use-structured-agent-session', () =>
  moduleFactories.useStructuredAgentSession()
)
vi.mock('../../appearance/use-native-chat-font-size', () => moduleFactories.useNativeChatFontSize())
vi.mock('../../links/actions/use-native-chat-file-link-context', () =>
  moduleFactories.useNativeChatFileLinkContext()
)
vi.mock('../../links/actions/use-native-chat-file-link-click', () =>
  moduleFactories.useNativeChatFileLinkClick()
)
vi.mock('../../NativeChatMessageList', () => moduleFactories.nativeChatMessageList())
vi.mock('../../composer/NativeChatComposer', () => moduleFactories.nativeChatComposer())
vi.mock('../../prompts/NativeChatApprovalCard', () => moduleFactories.nativeChatApprovalCard())
vi.mock('../../prompts/NativeChatQuestionCard', () => moduleFactories.nativeChatQuestionCard())

afterEach(() => {
  cleanup()
  resetStructuredSessionMocks()
})

{
  const STILL_WORKING = "The agent is still working. Run /clear when it's done."
  const BACKGROUND =
    'Background tasks are still running. Wait for the background tasks to finish. Run /clear again.'

  function renderPane() {
    const pane = () => (
      <NativeChatStructuredSession
        isVisible
        isFocusedGroup
        tabId="refusal-line-tab"
        sessionId="refusal-line-session"
        target={{ kind: 'local' }}
        agent="claude"
      />
    )
    const view = render(pane())
    // A fresh element: the mocked controller reads the chat's state only when the pane renders.
    return { rerender: () => view.rerender(pane()) }
  }

  function composerSays(
    text: string | null,
    refusedWhile?: StructuredAgentSessionCommandRefusalCause
  ) {
    const onError = mocks.composerProps?.structuredTransport?.onError
    if (typeof onError !== 'function') {
      throw new Error('the composer has no transport')
    }
    act(() => onError(text, { refusedWhile }))
  }

  it('a /clear refused while the agent works is said until the agent stops, then gone', () => {
    mocks.turnId = 'turn-1'
    const pane = renderPane()
    composerSays(STILL_WORKING, 'working')
    expect(screen.getAllByText(STILL_WORKING)).toHaveLength(1)

    mocks.turnId = null
    pane.rerender()
    expect(screen.queryByText(STILL_WORKING)).toBeNull()
    // Gone, not hidden: the agent working again later is not what that press was refused for.
    mocks.turnId = 'turn-2'
    pane.rerender()
    expect(screen.queryByText(STILL_WORKING)).toBeNull()
  })

  it('a /clear refused behind background tasks is said until the last one ends, then gone', () => {
    mocks.monitoringBackgroundTasks = true
    const pane = renderPane()
    composerSays(BACKGROUND, 'background')
    expect(screen.getAllByText(BACKGROUND)).toHaveLength(1)

    mocks.monitoringBackgroundTasks = false
    pane.rerender()
    expect(screen.queryByText(BACKGROUND)).toBeNull()
  })
}
