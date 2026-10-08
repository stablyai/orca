// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { agentSessionFailureWords } from '../../../../shared/agent-session-failure-words'
import type { AgentSessionFailureFact } from '../../../../shared/agent-session-failure'
import { agentJournalItemKey } from '../../../../shared/agent-session-journal-item-key'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session-journal-types'
import { structuredAgentSessionStartFailureRowIdentity } from '../../../../shared/structured-agent-session-start-failure-row-key'

const { mocks, moduleFactories, resetStructuredSessionMocks } = await vi.hoisted(async () =>
  (await import('./NativeChatStructuredSession.test-harness')).createStructuredSessionMocks()
)

vi.mock('@/lib/structured-agent-session-launch', () =>
  moduleFactories.structuredAgentSessionLaunch()
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

// The host's verdict is a notice that never holds Send: it can be wrong while a send would work.

const CODEX_SIGNED_OUT = "Codex isn't signed in. Run `codex login`."
const CODEX_MISSING =
  "Codex wasn't found on the computer running this chat. Install it, or check its Command in Settings → Agents."

afterEach(() => {
  cleanup()
  localStorage.clear()
  resetStructuredSessionMocks()
})

function pane(agent: 'claude' | 'codex' = 'codex'): React.JSX.Element {
  return (
    <NativeChatStructuredSession
      isVisible
      isFocusedGroup
      tabId="availability-tab"
      sessionId="availability-session"
      target={{ kind: 'local' }}
      agent={agent}
    />
  )
}

function startFailureRow(fact: AgentSessionFailureFact): AgentJournalRenderItem {
  return {
    itemId: agentJournalItemKey(structuredAgentSessionStartFailureRowIdentity('generation-1')),
    revision: 1,
    sequence: 1,
    observedAt: 1,
    body: {
      kind: 'status',
      tone: 'error',
      ...agentSessionFailureWords(fact, { agentName: 'Codex', surface: 'row' })
    }
  }
}

function turnRow(): AgentJournalRenderItem {
  return {
    itemId: agentJournalItemKey({
      provider: 'codex',
      threadId: 'thread-1',
      turnId: 'turn-1',
      ordinal: 0
    }),
    revision: 1,
    sequence: 2,
    observedAt: 2,
    body: { kind: 'turn', turnId: 'turn-1', state: 'completed', startedAt: 2, completedAt: 3 }
  }
}

it('says a signed-out Codex above the composer and still sends', () => {
  mocks.unavailable = { reason: 'notSignedIn', account: 'system' }
  render(pane())

  expect(screen.getByText(CODEX_SIGNED_OUT)).toBeTruthy()
  const transport = mocks.composerProps?.structuredTransport
  expect(transport).not.toHaveProperty('unavailable')
  const send = transport?.send
  if (typeof send !== 'function') {
    throw new Error('Structured composer transport was not installed')
  }
  let admitted: unknown
  act(() => {
    admitted = send('hello', [])
  })
  expect(admitted).toBe(true)
  expect(mocks.send).toHaveBeenCalledWith('hello', [])
})

it('stays dismissed for the same verdict, and shows again when it changes or comes back', () => {
  mocks.unavailable = { reason: 'notSignedIn', account: 'system' }
  const view = render(pane())
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
  expect(screen.queryByText(CODEX_SIGNED_OUT)).toBeNull()
  view.rerender(pane())
  expect(screen.queryByText(CODEX_SIGNED_OUT)).toBeNull()

  mocks.unavailable = { reason: 'cliMissing' }
  view.rerender(pane())
  expect(screen.getByText(CODEX_MISSING)).toBeTruthy()
  // Changed, so the earlier dismissal is spent: the first verdict coming back shows again.
  mocks.unavailable = { reason: 'notSignedIn', account: 'system' }
  view.rerender(pane())
  expect(screen.getByText(CODEX_SIGNED_OUT)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))

  mocks.unavailable = null
  view.rerender(pane())
  expect(screen.queryByText(CODEX_MISSING)).toBeNull()
  // Cleared, so the dismissed verdict is new again when it returns.
  mocks.unavailable = { reason: 'notSignedIn', account: 'system' }
  view.rerender(pane())
  expect(screen.getByText(CODEX_SIGNED_OUT)).toBeTruthy()
})

it("names a missing Claude CLI in the chat's agent", () => {
  mocks.unavailable = { reason: 'cliMissing' }
  render(pane('claude'))
  expect(
    screen.getByText(
      "Claude wasn't found on the computer running this chat. Install it, or check its Command in Settings → Agents."
    )
  ).toBeTruthy()
})

it('says a reason once when the failed start already says it, keeping its Retry', () => {
  mocks.launchLifecycle = 'failed'
  mocks.launchFailure = {
    kind: 'refused',
    code: 'agent_session_operation_invalid',
    details: { reason: 'notSignedIn' }
  }
  mocks.unavailable = { reason: 'notSignedIn', account: 'system' }
  render(pane())

  expect(screen.getAllByText(new RegExp(CODEX_SIGNED_OUT.replace(/[.`]/g, '\\$&')))).toHaveLength(1)
  expect(screen.getByText(`Chat could not be started. ${CODEX_SIGNED_OUT}`)).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy()
})

it("leaves the reason to the transcript's start-failure row, but not a different one", () => {
  mocks.journalItems = [startFailureRow({ kind: 'notSignedIn' })]
  mocks.unavailable = { reason: 'notSignedIn', account: 'system' }
  const view = render(pane())
  expect(screen.queryByText(CODEX_SIGNED_OUT)).toBeNull()

  mocks.unavailable = { reason: 'cliMissing' }
  view.rerender(pane())
  expect(screen.getByText(CODEX_MISSING)).toBeTruthy()
})

it('ignores a failed start that a turn has run since', () => {
  mocks.journalItems = [startFailureRow({ kind: 'notSignedIn' }), turnRow()]
  mocks.unavailable = { reason: 'notSignedIn', account: 'system' }
  render(pane())
  expect(screen.getByText(CODEX_SIGNED_OUT)).toBeTruthy()
})
