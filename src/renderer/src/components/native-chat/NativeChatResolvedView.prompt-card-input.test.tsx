import type * as VerifiedRuntimeInput from '@/runtime/runtime-terminal-verified-input'
import { clearCommandMarkerCacheForTests } from './native-chat-command-marker'
import { messageQuestionFixture } from '../../../../shared/message-question-occurrence.test-fixture'
// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { AgentStatusPayload } from '../../../../shared/agent-status-types'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import type { NativeChatLiveSession } from './use-native-chat-live-session'

// The composer is a marker that counts its mounts, so the test sees whether the view remounted it.
const retained = vi.hoisted((): { session: NativeChatLiveSession | null } => ({ session: null }))
const composer = vi.hoisted(() => ({ mounts: 0 }))
const ptyInput = vi.hoisted(() => ({
  verified: vi.fn<typeof VerifiedRuntimeInput.sendRuntimePtyInputVerified>()
}))
vi.mock('./use-native-chat-retained-session', () => ({
  useNativeChatRetainedSession: () => retained.session
}))
vi.mock('./NativeChatComposer', async () => {
  const { useEffect } = await import('react')
  return {
    NativeChatComposer: ({ onSlashCommand }: { onSlashCommand: (command: string) => void }) => {
      useEffect(() => {
        composer.mounts += 1
      }, [])
      return (
        <div data-testid="native-chat-composer">
          <button onClick={() => onSlashCommand('/clear')}>Dispatch clear</button>
        </div>
      )
    }
  }
})
vi.mock('@/runtime/runtime-terminal-verified-input', () => ({
  sendRuntimePtyInputVerified: ptyInput.verified
}))

const verifiedInput = await vi.importActual<typeof VerifiedRuntimeInput>(
  '@/runtime/runtime-terminal-verified-input'
)
const { terminalQuestionAvailabilityFixture } =
  await import('../../../../main/native-chat/transcript-question-availability.test-fixture')

const { NativeChatResolvedView } = await import('./NativeChatResolvedView')
const { TooltipProvider } = await import('@/components/ui/tooltip')
const { nativeChatPromptDismissals } = await import('./native-chat-prompt-dismissals')
const { useAppStore } = await import('../../store')
const { installNativeChatMessageListTestViewport } =
  await import('./native-chat-message-list-test-viewport')

const paneKey = 'tab-card:leaf-card'
let restoreViewport = (): void => {}

const userTurn: NativeChatMessage = {
  id: 'user-1',
  role: 'user',
  blocks: [{ type: 'text', text: 'Clean the build' }],
  timestamp: 1,
  source: 'transcript'
}

const APPROVAL = JSON.stringify({ approval: { tool: 'Bash', summary: 'npm test' } })
const ASK_CALL: NativeChatMessage = {
  id: 'call-ask',
  role: 'assistant',
  timestamp: 2,
  source: 'transcript',
  blocks: [
    {
      type: 'tool-call',
      name: 'AskUserQuestion',
      input: {
        questions: [
          { question: 'Tabs or spaces?', multiSelect: false, options: [{ label: 'Tabs' }] }
        ]
      }
    }
  ]
}

function transcript(): NativeChatLiveSession {
  return {
    messages: [userTurn],
    status: 'ready',
    sessionId: 'session-card',
    agent: 'claude',
    hookAwaitingInput: true,
    hasMore: false,
    loadingEarlier: false,
    olderHistoryGeneration: 0,
    loadEarlier: vi.fn(),
    readPhase: 'ready'
  }
}

function setStatus(
  payload: Omit<AgentStatusPayload, 'prompt' | 'agentType'>,
  stateStartedAt?: number
): void {
  useAppStore
    .getState()
    .setAgentStatus(
      paneKey,
      { prompt: 'Clean the build', agentType: 'claude', ...payload },
      undefined,
      stateStartedAt === undefined ? undefined : { stateStartedAt }
    )
}

function renderPane(targetPtyId = 'pty-card'): ReturnType<typeof render> {
  return render(paneElement(targetPtyId))
}

function paneElement(targetPtyId = 'pty-card'): React.JSX.Element {
  return (
    <TooltipProvider>
      <NativeChatResolvedView
        paneKey={paneKey}
        agent="claude"
        sessionId="session-card"
        transcriptPath={null}
        isVisible
        isFocusedGroup
        targetPtyId={targetPtyId}
        terminalTabId="tab-card"
        ownsTabWideLaunchDraft={false}
      />
    </TooltipProvider>
  )
}

beforeEach(() => {
  restoreViewport = installNativeChatMessageListTestViewport()
  composer.mounts = 0
  nativeChatPromptDismissals.clearForTests()
  clearCommandMarkerCacheForTests()
  ptyInput.verified.mockReset()
  useAppStore.setState({ agentStatusByPaneKey: {}, nativeChatLaunchPromptByTabId: {} })
  retained.session = transcript()
})

afterEach(() => {
  cleanup()
  restoreViewport()
  useAppStore.setState({ agentStatusByPaneKey: {}, nativeChatLaunchPromptByTabId: {} })
})

// Prompt cards own terminal input because composer sends would otherwise answer the agent’s active selector.
describe('NativeChatResolvedView prompt cards own the input region', () => {
  it('shows the composer when no prompt is pending', () => {
    setStatus({ state: 'working' })

    renderPane()

    expect(screen.getByTestId('native-chat-composer')).toBeInTheDocument()
  })

  it('hides the composer under an approval, and shows it again once Allow lands', async () => {
    ptyInput.verified.mockResolvedValue(true)
    setStatus({
      state: 'waiting',
      interactivePrompt: JSON.stringify({ approval: { tool: 'Bash', summary: 'rm -rf build' } })
    })

    renderPane()

    const card = document.querySelector('[data-native-chat-approval-card="true"]')
    expect(card).not.toBeNull()
    expect(screen.getByTestId('native-chat-composer').closest('[hidden]')).not.toBeNull()
    // No text field is visible, so keyboard focus lands on the card's choices.
    expect(document.activeElement).toBe(card)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Allow' }))
    })

    expect(ptyInput.verified).toHaveBeenCalledOnce()
    expect(screen.getByTestId('native-chat-composer').closest('[hidden]')).toBeNull()
    expect(composer.mounts).toBe(1)
  })

  it('keeps the approval up when its choice was not delivered', async () => {
    ptyInput.verified.mockRejectedValue(new Error('delivery unknown'))
    setStatus({
      state: 'waiting',
      interactivePrompt: JSON.stringify({ approval: { tool: 'Bash', summary: 'rm -rf build' } })
    })

    renderPane()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Allow' }))
    })

    expect(screen.getByRole('button', { name: 'Allow' })).toBeEnabled()
    expect(screen.getByTestId('native-chat-composer').closest('[hidden]')).not.toBeNull()
  })

  it('hides the composer behind a question card', () => {
    setStatus({
      state: 'waiting',
      toolName: 'AskUserQuestion',
      interactivePrompt: JSON.stringify({
        questions: [
          {
            question: 'Which folder?',
            multiSelect: false,
            options: [{ label: 'build' }, { label: 'dist' }]
          }
        ]
      })
    })

    renderPane()

    expect(screen.getAllByText('Which folder?').length).toBeGreaterThan(0)
    expect(screen.getByTestId('native-chat-composer').closest('[hidden]')).not.toBeNull()
  })

  it('keeps an answered approval hidden across a chat view remount and a PTY rebind', async () => {
    ptyInput.verified.mockResolvedValue(true)
    setStatus({
      state: 'waiting',
      interactivePrompt: JSON.stringify({ approval: { tool: 'Bash', summary: 'npm test' } })
    })
    const first = renderPane()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Allow' }))
    })
    // The approved tool is still running, so the host status lingers: a chat/terminal toggle.
    first.unmount()
    const second = renderPane()
    expect(document.querySelector('[data-native-chat-approval-card="true"]')).toBeNull()
    expect(screen.getByTestId('native-chat-composer').closest('[hidden]')).toBeNull()

    second.unmount()
    renderPane('pty-card-reconnected')
    expect(document.querySelector('[data-native-chat-approval-card="true"]')).toBeNull()
    expect(ptyInput.verified).toHaveBeenCalledOnce()
  })

  it('collapses to a strip that frees the composer, and expanding gives the card the input back', () => {
    setStatus({ state: 'waiting', interactivePrompt: APPROVAL })
    renderPane()
    fireEvent.click(screen.getByRole('button', { name: 'Collapse' }))

    const collapsedCard = document.querySelector('[data-native-chat-approval-card="true"]')
    expect(collapsedCard?.closest('[hidden]')).toHaveAttribute('inert')
    expect(document.querySelector('[data-native-chat-prompt-strip="true"]')).toHaveTextContent(
      'Allow Bash?'
    )
    expect(screen.queryAllByText(/Awaiting user input/)).toHaveLength(0)
    expect(screen.getByTestId('native-chat-composer').closest('[hidden]')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Expand' }))
    expect(document.activeElement).toBe(
      document.querySelector('[data-native-chat-approval-card="true"]')
    )
    expect(screen.getByTestId('native-chat-composer').closest('[hidden]')).not.toBeNull()
    expect(ptyInput.verified).not.toHaveBeenCalled()
  })

  it('shows an identical question again in a new wait that arrived while the view was unmounted', () => {
    const question = JSON.stringify({
      questions: [{ question: 'Continue?', multiSelect: false, options: [{ label: 'Yes' }] }]
    })
    const ask = {
      state: 'waiting',
      toolName: 'AskUserQuestion',
      interactivePrompt: question
    } as const
    setStatus(ask, 100)
    const first = renderPane()
    fireEvent.click(screen.getByRole('button', { name: 'Collapse' }))
    first.unmount()
    setStatus({ state: 'working' }, 200)
    setStatus(ask, 300)
    renderPane()
    expect(screen.getByTestId('native-chat-question-card-title')).toHaveTextContent('Continue?')
  })

  it('keeps a collapsed transcript question collapsed while the transcript re-reads', () => {
    const withAsk = { ...transcript(), messages: [userTurn, ASK_CALL] }
    retained.session = withAsk
    setStatus({ state: 'waiting' })
    const view = renderPane()
    fireEvent.click(screen.getByRole('button', { name: 'Collapse' }))
    retained.session = { ...withAsk, messages: [], readPhase: 'loading' }
    view.rerender(paneElement())
    retained.session = withAsk
    view.rerender(paneElement())
    expect(document.querySelector('[data-native-chat-prompt-strip="true"]')).not.toBeNull()
  })

  it('keeps a partly answered question across collapse and expand, and Escape in its text field', () => {
    setStatus(
      {
        state: 'waiting',
        toolName: 'AskUserQuestion',
        interactivePrompt: JSON.stringify({
          questions: [
            { question: 'Which folder?', multiSelect: false, options: [{ label: 'dist' }] },
            { question: 'Which mode?', multiSelect: false, options: [{ label: 'slow' }] }
          ]
        })
      },
      100
    )
    renderPane()
    fireEvent.click(screen.getByRole('button', { name: /dist/ }))
    fireEvent.click(screen.getByRole('button', { name: /Next/ }))
    const other = screen.getByPlaceholderText('Type your answer')
    fireEvent.change(other, { target: { value: 'turbo' } })
    fireEvent.keyDown(other, { key: 'Escape' })
    expect(document.querySelector('[data-native-chat-prompt-strip="true"]')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Collapse' }))
    fireEvent.click(screen.getByRole('button', { name: 'Expand' }))
    expect(screen.getByTestId('native-chat-question-card-title')).toHaveTextContent('Which mode?')
    expect(screen.getByPlaceholderText('Type your answer')).toHaveValue('turbo')
  })
})

it.each([10, 100])(
  'keeps the composer usable and skips record visits on history appends before clearing %i host controls',
  (count) => {
    const now = Date.now()
    const prompt = {
      replyAsMessage: true as const,
      occurrenceKey: '["q1"]',
      questions: [{ question: 'Which color?', multiSelect: false, options: [{ label: 'Blue' }] }]
    }
    const row = messageQuestionFixture('q1', { timestamp: now - 1000, questions: prompt.questions })
    let timestampReads = 0
    const records = Array.from({ length: count }, (_, index) => {
      const record = { ...row, id: `q1-${index}`, sourceRowId: `q1-${index}` }
      Object.defineProperty(record, 'timestamp', {
        get: () => {
          timestampReads++
          return now - 1000
        }
      })
      return record
    })
    retained.session = {
      ...transcript(),
      hookAwaitingInput: false,
      asyncQuestion: prompt,
      messageQuestions: { records, ready: true }
    }
    setStatus({ state: 'working' })
    const view = renderPane()
    expect(screen.getByTestId('native-chat-question-card-title')).toHaveTextContent('Which color?')
    expect(screen.getByTestId('native-chat-composer').closest('[hidden]')).toBeNull()
    timestampReads = 0
    for (let index = 0; index < 3; index++) {
      retained.session = {
        ...retained.session!,
        messages: [
          userTurn,
          {
            id: `output-${index}`,
            role: 'assistant',
            blocks: [{ type: 'text', text: `Still working ${index}` }],
            timestamp: now,
            source: 'transcript'
          }
        ]
      }
      view.rerender(paneElement())
    }
    expect(timestampReads).toBe(0)
    fireEvent.click(screen.getByRole('button', { name: 'Dispatch clear' }))
    expect(timestampReads).toBeGreaterThan(0)
    expect(screen.queryByTestId('native-chat-question-card-title')).toBeNull()
    view.rerender(paneElement())
    expect(screen.queryByTestId('native-chat-question-card-title')).toBeNull()
    retained.session = {
      ...transcript(),
      hookAwaitingInput: false,
      asyncQuestion: { ...prompt, occurrenceKey: '["q2"]' },
      messageQuestions: {
        records: [{ ...row, id: 'q2', sourceRowId: 'q2', timestamp: now + 1000 }],
        ready: true
      }
    }
    view.rerender(paneElement())
    expect(screen.getByTestId('native-chat-question-card-title')).toHaveTextContent('Which color?')
    expect(screen.getByTestId('native-chat-composer').closest('[hidden]')).toBeNull()
  }
)

it('keeps actual terminal approval and question writes usable through cold and established async unavailability', async () => {
  const source = await terminalQuestionAvailabilityFixture()
  const previousApi = Object.getOwnPropertyDescriptor(window, 'api')
  const write = vi.fn<typeof window.api.pty.writeAccepted>()
  const inferQuestionAnswered = vi
    .fn<typeof window.api.agentStatus.inferQuestionAnswered>()
    .mockResolvedValue(false)
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      ...window.api,
      pty: { ...window.api?.pty, writeAccepted: write },
      agentStatus: { ...window.api?.agentStatus, inferQuestionAnswered }
    }
  })
  ptyInput.verified.mockImplementation(verifiedInput.sendRuntimePtyInputVerified)
  let pane: ReturnType<typeof renderPane> | undefined
  const showSource = () => {
    retained.session = { ...transcript(), messageQuestions: source.view() }
    if (pane) {
      pane.rerender(paneElement())
    }
  }
  try {
    await vi.waitFor(() => expect(source.view()).toEqual({ records: [], ready: false }))
    showSource()
    setStatus({ state: 'waiting', interactivePrompt: APPROVAL })
    pane = renderPane()
    const approval = Promise.withResolvers<boolean>()
    write.mockReturnValueOnce(approval.promise)
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Allow' })))
    expect(write).toHaveBeenCalledExactlyOnceWith(
      'pty-card',
      expect.any(String),
      expect.any(String),
      { requireWriteSettlement: true }
    )
    expect(source.view()?.ready).toBe(false)
    await act(async () => approval.resolve(true))
    expect(document.querySelector('[data-native-chat-approval-card="true"]')).toBeNull()
    source.enable()
    await vi.waitFor(() => expect(source.view()?.ready).toBe(true))
    await source.failCreation()
    await vi.waitFor(() => {
      expect(source.state().requestAuthority).toBeDefined()
      expect(source.state().asyncQuestionAuthority).toBeUndefined()
      expect(source.view()).toMatchObject({ records: [expect.anything()], ready: false })
    })
    showSource()
    act(() =>
      setStatus(
        {
          state: 'waiting',
          toolName: 'AskUserQuestion',
          interactivePrompt: JSON.stringify({
            questions: [
              { question: 'Independent terminal choice?', options: [{ label: 'Continue' }] }
            ]
          })
        },
        200
      )
    )
    expect(screen.getByTestId('native-chat-question-card-title')).toHaveTextContent(
      'Independent terminal choice?'
    )
    const question = Promise.withResolvers<boolean>()
    write.mockReturnValue(question.promise)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Continue/ }))
    })
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(2))
    expect(source.view()?.ready).toBe(false)
    await act(async () => question.resolve(true))
    await vi.waitFor(() => expect(screen.queryByText('Independent terminal choice?')).toBeNull())
    expect(inferQuestionAnswered).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('native-chat-composer').closest('[hidden]')).toBeNull()
    source.restoreCreation()
    await vi.waitFor(() => expect(source.view()?.ready).toBe(true))
    expect(source.view()?.records).toHaveLength(2)
  } finally {
    pane?.unmount()
    if (previousApi) {
      Object.defineProperty(window, 'api', previousApi)
    } else {
      Reflect.deleteProperty(window, 'api')
    }
    await source.close()
  }
}, 15_000)
