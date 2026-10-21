// @vitest-environment happy-dom

import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { StructuredAgentSessionCommandRefusalCause } from '../../../../shared/structured-agent-session-composer'
import { NativeChatStructuredSession } from './NativeChatStructuredSession'

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

afterEach(() => {
  cleanup()
  resetStructuredSessionMocks()
})

{
  function renderPane(): void {
    render(
      <NativeChatStructuredSession
        isVisible
        isFocusedGroup
        tabId="structured-read-error-tab"
        sessionId="read-error-session"
        target={{ kind: 'local' }}
        agent="codex"
      />
    )
  }

  function journalRefusal(
    reason: 'journalCorrupt' | 'journalUnavailable' | 'journalWrittenByNewerOrca'
  ) {
    return { code: 'agent_session_journal_unreadable', details: { reason } } as const
  }

  // The host's message and code never reach the pane; it words the refusal, and says it once. The
  // read retries on its own, which the pane does not report.
  it('says only that a failed read with no refusal did not load, and adds nothing of the host', () => {
    mocks.status = 'error'
    mocks.messages = []

    renderPane()

    expect(screen.getByText('Could not load conversation')).toBeTruthy()
    expect(screen.queryByText(/keeps trying/)).toBeNull()
    expect(screen.queryByText(/history couldn't be loaded/)).toBeNull()
    expect(screen.queryByText(/Toggle back to the terminal/)).toBeNull()
  })

  it('says a damaged history cannot load in one line, without claiming Orca keeps trying', () => {
    mocks.status = 'error'
    mocks.readRefusal = journalRefusal('journalCorrupt')
    mocks.messages = []

    renderPane()

    expect(screen.getAllByText('Unable to load this chat.')).toHaveLength(1)
    expect(screen.queryByText('Could not load conversation')).toBeNull()
    expect(screen.queryByText(/keeps trying/)).toBeNull()
    expect(screen.queryByText(/agent_session_/)).toBeNull()
    // Nothing to send into: a send would only be refused and say it again.
    expect(mocks.composerProps).toBeNull()
  })

  it("names a history that couldn't open right now once, in its one line", () => {
    mocks.status = 'error'
    mocks.readRefusal = journalRefusal('journalUnavailable')
    mocks.messages = []

    renderPane()

    expect(screen.getAllByText("Orca couldn't open this chat's history right now.")).toHaveLength(1)
    expect(screen.queryByText('Could not load conversation')).toBeNull()
    expect(screen.queryByText(/keeps trying/)).toBeNull()
    expect(screen.queryByText(/Try again/)).toBeNull()
    // It can clear, so the composer stays and a send waits for the read.
    expect(mocks.composerProps).not.toBeNull()
  })

  it("says a code's own words that the history didn't load, and nothing under them", () => {
    mocks.status = 'error'
    mocks.readRefusal = {
      code: 'agent_session_checkpoint_stale',
      details: { reason: 'fenceStale' }
    } as const
    mocks.messages = []

    renderPane()

    expect(screen.getAllByText("This chat's history couldn't be loaded.")).toHaveLength(1)
    expect(screen.queryByText(/keeps trying/)).toBeNull()
  })

  // "This isn't available in this chat." would name nothing the reader asked for.
  it('says why the history did not load for a chat its host cannot run', () => {
    mocks.status = 'error'
    mocks.readRefusal = {
      code: 'structured_agent_session_unsupported',
      details: { reason: 'hostUnsupported' }
    } as const
    mocks.messages = []

    renderPane()

    expect(
      screen.getAllByText(
        "Orca can't run this agent in a chat here. This chat's history couldn't be loaded."
      )
    ).toHaveLength(1)
    expect(screen.queryByText(/isn't available|newer Orca/)).toBeNull()
  })

  it('says once that a newer Orca saved the chat and only an update opens it, with no composer', () => {
    mocks.status = 'error'
    mocks.readRefusal = journalRefusal('journalWrittenByNewerOrca')
    mocks.messages = []

    renderPane()

    expect(
      screen.getAllByText('This chat was saved by a newer Orca. Update Orca to open it.')
    ).toHaveLength(1)
    expect(screen.queryByText('Could not load conversation')).toBeNull()
    expect(screen.queryByText(/keeps trying/)).toBeNull()
    expect(mocks.composerProps).toBeNull()
  })

  // Only a chat that never loaded stores a failure with no host refusal (the read owner drops it after load).
  it('says once that the history did not load beside a bubble of a chat that never loaded', () => {
    mocks.status = 'error'

    render(
      <NativeChatStructuredSession
        isVisible
        isFocusedGroup
        tabId="structured-read-error-tab"
        sessionId="read-error-session"
        target={{ kind: 'environment', environmentId: 'remote-host' }}
        agent="codex"
      />
    )

    expect(screen.getByTestId('message-list')).toBeTruthy()
    expect(screen.getByTestId('structured-composer')).toBeTruthy()
    expect(screen.getAllByText("This chat's history couldn't be loaded.")).toHaveLength(1)
    expect(screen.queryByText(/reconnect/i)).toBeNull()
  })

  it('words a failed reconnect beside a transcript it keeps', () => {
    mocks.status = 'error'
    mocks.readRefusal = journalRefusal('journalUnavailable')

    renderPane()

    expect(screen.getByTestId('message-list')).toBeTruthy()
    expect(screen.getByText("Orca couldn't open this chat's history right now.")).toBeTruthy()
  })
}

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
}
