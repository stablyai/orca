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
const ptyInput = vi.hoisted(() => ({ verified: vi.fn<() => Promise<boolean>>() }))
vi.mock('./use-native-chat-retained-session', () => ({
  useNativeChatRetainedSession: () => retained.session
}))
vi.mock('./NativeChatComposer', async () => {
  const { useEffect } = await import('react')
  return {
    NativeChatComposer: () => {
      useEffect(() => {
        composer.mounts += 1
      }, [])
      return <div data-testid="native-chat-composer" />
    }
  }
})
vi.mock('@/runtime/runtime-terminal-verified-input', () => ({
  sendRuntimePtyInputVerified: ptyInput.verified
}))

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
  ptyInput.verified.mockReset()
  useAppStore.setState({ agentStatusByPaneKey: {}, nativeChatLaunchPromptByTabId: {} })
  retained.session = transcript()
})

afterEach(() => {
  cleanup()
  restoreViewport()
  useAppStore.setState({ agentStatusByPaneKey: {}, nativeChatLaunchPromptByTabId: {} })
})

// A terminal-backed send types into the PTY, so whatever card is up would take the message as its
// answer. Every answerable card owns the input region, as structured chat's cards do.
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
