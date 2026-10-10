// @vitest-environment happy-dom

import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { StructuredAgentSessionCommandRefusalCause } from '../../../../shared/structured-agent-session-composer'

const { mocks, moduleFactories, resetStructuredSessionMocks } = await vi.hoisted(async () =>
  (await import('./NativeChatStructuredSession.test-harness')).createStructuredSessionMocks()
)

vi.mock('@/runtime/structured-agent-session-client', () =>
  moduleFactories.structuredAgentSessionClient()
)
vi.mock('./use-structured-agent-session', () => moduleFactories.useStructuredAgentSession())
vi.mock('./use-native-chat-font-size', () => moduleFactories.useNativeChatFontSize())
vi.mock('./use-native-chat-file-link-context', () => moduleFactories.useNativeChatFileLinkContext())
vi.mock('./use-native-chat-file-link-click', () => moduleFactories.useNativeChatFileLinkClick())
vi.mock('./NativeChatMessageList', () => moduleFactories.nativeChatMessageList())
vi.mock('./NativeChatComposer', () => moduleFactories.nativeChatComposer())
vi.mock('./NativeChatApprovalCard', () => moduleFactories.nativeChatApprovalCard())
vi.mock('./NativeChatQuestionCard', () => moduleFactories.nativeChatQuestionCard())

import { NativeChatStructuredSession } from './NativeChatStructuredSession'

afterEach(() => {
  cleanup()
  resetStructuredSessionMocks()
})

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

it('a line naming nothing the chat shows stays until the next send, as before', () => {
  mocks.turnId = 'turn-1'
  const pane = renderPane()
  composerSays('Remove attachments before using a chat-session command.')
  mocks.turnId = null
  pane.rerender()
  expect(screen.getByText('Remove attachments before using a chat-session command.')).toBeTruthy()
  composerSays(null)
  expect(screen.queryByText('Remove attachments before using a chat-session command.')).toBeNull()
})
