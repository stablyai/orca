// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const hostLabel = (): string | null => 'studio-mac'
  const capability = (): 'unknown' | 'supported' | 'unsupported' => 'supported'
  const resuming: readonly string[] = []
  return {
    call: vi.fn(),
    capability: capability(),
    hostLabel: hostLabel(),
    resuming,
    launchPending: false
  }
})

vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call
}))
vi.mock('@/runtime/structured-agent-session-host-capability', () => ({
  useStructuredAgentSessionHostCapabilityState: () => mocks.capability
}))
vi.mock('../native-chat-resume-on-restart-store', () => ({
  useNativeChatRestartResuming: () => mocks.resuming
}))
vi.mock('../native-chat-launch-resume-decision', () => ({
  useNativeChatLaunchResumePending: () => mocks.launchPending
}))
vi.mock('./use-structured-agent-session-host-label', () => ({
  useStructuredAgentSessionHostLabel: () => mocks.hostLabel
}))

import { TooltipProvider } from '@/components/ui/tooltip'
import { agentJournalItemKey } from '../../../../shared/agent-session-journal-item-key'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../../shared/agent-session-journal-types'
import type { RuntimeClientTarget } from '@/runtime/runtime-client-target'
import {
  NativeChatInterruptedContinue,
  useNativeChatInterruptedContinuation
} from './NativeChatInterruptedContinue'

const TURN = agentJournalItemKey({ provider: 'codex', threadId: 't', turnId: 'cut', ordinal: 1 })
const PAIRED: RuntimeClientTarget = { kind: 'environment', environmentId: 'studio-mac' }

const cutChat: AgentJournalRenderItem[] = [
  {
    itemId: TURN,
    revision: 2,
    sequence: 1,
    observedAt: 1,
    body: { kind: 'turn', turnId: 'cut', state: 'interrupted', startedAt: 1, completedAt: 5 }
  },
  {
    itemId: agentJournalItemKey({ provider: 'orca', clientMessageId: 'stale-session:s:death-1-5' }),
    revision: 1,
    sequence: 2,
    observedAt: 6,
    turnScope: { kind: 'turn', turnItemId: TURN },
    body: { kind: 'status', text: 'Codex stopped.', tone: 'error', orcaStop: { cause: 'crash' } }
  }
]

type Props = {
  journalItems?: readonly AgentJournalRenderItem[]
  submissions?: readonly Pick<AgentJournalSubmission, 'dispatchState'>[]
  isWorking?: boolean
  target?: RuntimeClientTarget
}

function Harness(props: Props): React.JSX.Element {
  // The chat's own composer error, as NativeChatStructuredSession holds it.
  const [composerError, setComposerError] = useState<string | null>(null)
  const continuation = useNativeChatInterruptedContinuation({
    composer: { clearError: () => setComposerError(null) },
    target: props.target ?? PAIRED,
    sessionId: 'session-1',
    journalItems: props.journalItems ?? cutChat,
    submissions: props.submissions ?? [],
    isWorking: props.isWorking ?? false
  })
  return (
    <TooltipProvider delayDuration={0}>
      <span data-testid="offered">{continuation.offeredTurnItemId ?? 'none'}</span>
      <span data-testid="available">{String(continuation.view.continueAvailable)}</span>
      <span data-testid="error">
        {composerError ?? continuation.continueError?.text ?? 'none'}
      </span>
      <button type="button" onClick={() => setComposerError(ATTACHMENTS)}>
        compose
      </button>
      <NativeChatInterruptedContinue continuation={continuation} />
    </TooltipProvider>
  )
}

const continueButton = () => screen.queryByRole('button', { name: 'Continue' })
const FAILED = "Couldn't continue this chat. Try again, or send a message."
const ATTACHMENTS = 'Remove attachments before using a chat-session command.'

beforeEach(() => {
  mocks.capability = 'supported'
  mocks.resuming = []
  mocks.launchPending = false
  mocks.hostLabel = 'studio-mac'
  mocks.call.mockReset()
})

afterEach(cleanup)

describe('Continue on a reply an Orca stop cut off', () => {
  it("asks the chat's own host, paired or local, to continue that cut turn", () => {
    mocks.call.mockResolvedValue({ outcome: 'pending' })
    render(<Harness />)
    expect(screen.getByTestId('offered')).toHaveTextContent(TURN)

    fireEvent.click(continueButton()!)

    expect(mocks.call).toHaveBeenCalledExactlyOnceWith(PAIRED, 'agentSession.continueInterrupted', {
      sessionId: 'session-1',
      turnItemId: TURN
    })
    // Gone once asked, and the row gets its own way on back: the journal shows what came of it.
    expect(continueButton()).toBeNull()
    expect(screen.getByTestId('offered')).toHaveTextContent('none')
  })

  it('says what it does, for a reader and on hover', () => {
    render(<Harness />)
    expect(continueButton()).toHaveAccessibleDescription(
      'Continue, and the agent first checks whether its last step finished.'
    )
  })

  it('is not offered by a host without the operation; the user continues by sending', () => {
    mocks.capability = 'unsupported'
    render(<Harness />)
    expect(continueButton()).toBeNull()
    expect(screen.getByTestId('available')).toHaveTextContent('false')
  })

  it('tells the rows the same thing before the host answers, after it answers, and after a click', () => {
    mocks.capability = 'unknown'
    mocks.call.mockResolvedValue({ outcome: 'pending' })
    const { rerender } = render(<Harness />)
    expect(screen.getByTestId('available')).toHaveTextContent('true')
    expect(continueButton()).toBeNull()

    mocks.capability = 'supported'
    rerender(<Harness />)
    expect(screen.getByTestId('available')).toHaveTextContent('true')
    fireEvent.click(continueButton()!)

    expect(screen.getByTestId('available')).toHaveTextContent('true')
  })

  it('is not offered while the restart prompt or the launch is resuming this chat', () => {
    mocks.resuming = ['session-1']
    render(<Harness />)
    expect(continueButton()).toBeNull()
  })

  it("is not offered on this machine's chats while the launch may still resume them", () => {
    mocks.launchPending = true
    render(<Harness target={{ kind: 'local' }} />)
    expect(continueButton()).toBeNull()
    cleanup()
    // The launch resumes only this machine's chats; a paired server's chat is its own.
    render(<Harness />)
    expect(continueButton()).toBeInTheDocument()
  })

  it('is not offered once anything was sent, or while the agent works', () => {
    render(<Harness submissions={[{ dispatchState: 'pending' }]} />)
    expect(continueButton()).toBeNull()
    cleanup()
    render(<Harness isWorking />)
    expect(continueButton()).toBeNull()
  })

  it('is not offered for a cut no Orca stop explains', () => {
    render(<Harness journalItems={cutChat.slice(0, 1)} />)
    expect(continueButton()).toBeNull()
  })

  it('says so once, in the composer, and offers it again when the host refuses', async () => {
    mocks.call.mockResolvedValue({ outcome: 'refused', reason: 'agent_session_not_attached' })
    render(<Harness />)

    fireEvent.click(continueButton()!)
    await waitFor(() => expect(continueButton()).toBeInTheDocument())
    expect(screen.getByTestId('error')).toHaveTextContent(FAILED)
    // A retry clears the line until its own answer, which sets the same one line again.
    fireEvent.click(continueButton()!)
    expect(screen.getByTestId('error')).toHaveTextContent('none')
    await waitFor(() => expect(continueButton()).toBeInTheDocument())
    expect(screen.getByTestId('error')).toHaveTextContent(FAILED)
  })

  it('says so and offers it again when the request fails', async () => {
    mocks.call.mockRejectedValue(new Error('offline'))
    render(<Harness />)

    fireEvent.click(continueButton()!)

    await waitFor(() => expect(screen.getByTestId('error')).toHaveTextContent(FAILED))
    expect(continueButton()).toBeInTheDocument()
  })

  it('replaces an older composer error with its own failure, and clears it when it goes through', async () => {
    mocks.call.mockResolvedValueOnce({ outcome: 'refused', reason: 'agent_session_conflict' })
    mocks.call.mockResolvedValueOnce({ outcome: 'pending' })
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: 'compose' }))
    expect(screen.getByTestId('error')).toHaveTextContent(ATTACHMENTS)

    fireEvent.click(continueButton()!)
    await waitFor(() => expect(continueButton()).toBeInTheDocument())
    expect(screen.getByTestId('error')).toHaveTextContent(FAILED)

    fireEvent.click(screen.getByRole('button', { name: 'compose' }))
    expect(screen.getByTestId('error')).toHaveTextContent(ATTACHMENTS)
    fireEvent.click(continueButton()!)
    await waitFor(() => expect(mocks.call).toHaveBeenCalledTimes(2))
    expect(screen.getByTestId('error')).toHaveTextContent('none')
  })

  it('leaves an unrelated composer error alone when the chat moves on by itself', () => {
    const { rerender } = render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: 'compose' }))
    rerender(<Harness submissions={[{ dispatchState: 'pending' }]} />)
    expect(screen.getByTestId('error')).toHaveTextContent(ATTACHMENTS)
  })

  it('drops the line once the chat was continued, here or by another client', async () => {
    // The answer was lost after the host accepted it.
    mocks.call.mockRejectedValue(new Error('timed out'))
    const { rerender } = render(<Harness />)
    fireEvent.click(continueButton()!)
    await waitFor(() => expect(screen.getByTestId('error')).toHaveTextContent(FAILED))

    // The journal then shows the continuation on its way: the chat is no longer on that cut.
    rerender(<Harness submissions={[{ dispatchState: 'pending' }]} />)

    expect(screen.getByTestId('error')).toHaveTextContent('none')
  })

  it('leaves no line when a retry finds the chat already continued', async () => {
    mocks.call.mockRejectedValueOnce(new Error('timed out'))
    mocks.call.mockResolvedValueOnce({ outcome: 'superseded' })
    render(<Harness />)
    fireEvent.click(continueButton()!)
    await waitFor(() => expect(screen.getByTestId('error')).toHaveTextContent(FAILED))

    fireEvent.click(continueButton()!)

    await waitFor(() => expect(mocks.call).toHaveBeenCalledTimes(2))
    expect(screen.getByTestId('error')).toHaveTextContent('none')
  })
})
