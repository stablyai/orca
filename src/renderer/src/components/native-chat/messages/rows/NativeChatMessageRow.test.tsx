import {
  NativeChatVisualOwnerContext,
  type NativeChatVisualOwner
} from '../../media/visuals/native-chat-visual-owner'
import { useNativeChatTranscriptSlots } from '../../conversation/slots/use-native-chat-transcript-slots'
import type { PropsWithChildren } from 'react'
// @vitest-environment happy-dom
import { NativeChatHostSetupContext } from '../../host-access/native-chat-host-setup'
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, renderHook, screen, waitFor } from '@testing-library/react'
import { render } from '../actions/native-chat-tooltip-test-harness'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Why: these fixtures have neither inline visual owners nor sender navigation.
const unusedChatLeaves = vi.hoisted(() => ({
  inlineVisual: vi.fn(() => {
    throw new Error('Unexpected inline visual in transcript fixture')
  }),
  openSender: vi.fn(() => {
    throw new Error('Unexpected sender navigation in transcript fixture')
  })
}))
vi.mock('../../media/visuals/NativeChatInlineVisual', () => ({
  NativeChatInlineVisual: unusedChatLeaves.inlineVisual
}))
vi.mock('@/lib/open-agent-message-sender', () => ({
  openAgentMessageSender: unusedChatLeaves.openSender
}))
afterEach(() => {
  expect(unusedChatLeaves.inlineVisual).not.toHaveBeenCalled()
  expect(unusedChatLeaves.openSender).not.toHaveBeenCalled()
})
import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'
import { codexImageItemBody } from '../../../../../../main/codex/structured/items/codex-image-item-translation'
import { nativeChatGeneratedImageAnswers } from '../../../../../../shared/native-chat/transcript/native-chat-generated-image-answers'
import { MessageRow } from './NativeChatMessageRow'
import type { NativeChatRewindSurface } from '../actions/use-native-chat-rewind-host'
import { readNativeChatQuotableSelection } from '../../selection-quotes/native-chat-quote-selection'
import type { AgentJournalSubmission } from '../../../../../../shared/agent-session/journal/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../../../../../../shared/agent-session/journal/agent-session-journal-item-key'
import { useStructuredAgentSessionDeliveryNotices } from '../../session/structured/delivery/use-structured-agent-session-delivery-notices'

const confirm = vi.hoisted(() => vi.fn())
vi.mock('@/lib/syntax-highlighting/oniguruma', async () => ({
  loadOniguruma: (await import('@/lib/syntax-highlighting/oniguruma-test-harness'))
    .loadNodeOniguruma
}))
vi.mock('@/components/confirmation-dialog-context', () => ({
  useConfirmationDialog: () => confirm
}))

afterEach(cleanup)
const signInView = { signingIn: false, signIn: vi.fn() }
const setupView = { signIn: signInView, install: null }

function renderMessage(
  role: NativeChatMessage['role'],
  timestamp: number | null = 0,
  rewind?: NativeChatRewindSurface
) {
  return render(
    <MessageRow
      message={{
        id: 'message',
        role,
        timestamp,
        source: 'transcript',
        blocks: [{ type: 'text', text: 'Message text' }]
      }}
      expandSignal={false}
      onScrollMessageToTop={vi.fn()}
      rewind={rewind}
    />
  )
}

describe('MessageRow control visibility', () => {
  it('rederives generated attachments when the shipping transcript gains or loses visual ownership', () => {
    const messages: NativeChatMessage[] = [
      {
        id: 'image',
        timestamp: 1,
        source: 'transcript',
        ...codexImageItemBody({
          type: 'imageGeneration',
          id: 'image',
          status: 'completed',
          savedPath: '/tmp/p.png'
        })
      },
      {
        id: 'answer',
        role: 'assistant',
        timestamp: 1,
        source: 'transcript',
        blocks: [{ type: 'text', text: '::orca-visual{file="plot.html" title="![](/tmp/p.png)"}' }]
      }
    ]
    const input = {
      messages,
      turnKeys: ['u', 'u'],
      liveTurnKey: undefined,
      receipts: new Map(),
      turnDiffs: new Map(),
      expandedTurnKeys: new Set<string>(),
      turnStatuses: {
        active: null,
        completedByTurn: { u: { startedAt: 0, workedSeconds: 3, thinking: false } }
      },
      isWorking: false,
      lifecycleWorking: false,
      line: { tailRow: null, thinking: false }
    }
    let owner: NativeChatVisualOwner | null = null
    function Wrapper({ children }: PropsWithChildren) {
      return (
        <NativeChatVisualOwnerContext.Provider value={owner}>
          {children}
        </NativeChatVisualOwnerContext.Provider>
      )
    }
    const { result, rerender } = renderHook(() => useNativeChatTranscriptSlots(input), {
      wrapper: Wrapper
    })
    const attachments = () =>
      result.current.slots.flatMap((slot) =>
        slot.kind === 'message' && slot.drawsMessage
          ? slot.message.blocks.filter((block) => block.type === 'image-ref')
          : []
      )
    expect(attachments()).toEqual([])
    owner = { target: { kind: 'local' }, worktreeId: 'workspace', sessionId: 'session' }
    rerender()
    expect(attachments()).toEqual([{ type: 'image-ref', path: '/tmp/p.png' }])
    owner = null
    rerender()
    expect(attachments()).toEqual([])
  })

  it('renders expanded generated work as a labelled step while the final answer owns its image and controls', () => {
    const source: NativeChatMessage = {
      id: 'generated',
      role: 'assistant',
      timestamp: 1,
      source: 'transcript',
      ...codexImageItemBody({
        type: 'imageGeneration',
        id: 'generated',
        status: 'completed',
        savedPath: '/tmp/p.png'
      })
    }
    const answer: NativeChatMessage = {
      id: 'answer',
      role: 'assistant',
      timestamp: 1,
      source: 'transcript',
      blocks: [{ type: 'text', text: 'Your picture.' }]
    }
    const rows = nativeChatGeneratedImageAnswers(
      [source, answer],
      ['u', 'u'],
      new Set(['u']),
      () => []
    )
    const { container, rerender } = render(
      <>
        {rows.map((message, index) => (
          <MessageRow
            key={message.id}
            message={message}
            endsResponse={index === 1}
            expandSignal={false}
            onScrollMessageToTop={vi.fn()}
          />
        ))}
      </>
    )
    expect(screen.getByText('Generated image')).toBeVisible()
    expect(container.querySelector('[data-native-chat-message-id="generated"]')).toBeNull()
    expect(container.querySelector('[data-native-chat-message-id="answer"]')).not.toBeNull()
    expect(screen.getAllByRole('button', { name: 'Copy message' })).toHaveLength(1)
    expect(rows[0]!.blocks.some((block) => block.type === 'image-ref')).toBe(false)
    expect(rows[1]!.blocks).toEqual([
      { type: 'text', text: 'Your picture.' },
      { type: 'image-ref', path: '/tmp/p.png' }
    ])
    rerender(
      <MessageRow
        message={source}
        endsResponse={false}
        activeTurnIsWorking
        expandSignal={false}
        onScrollMessageToTop={vi.fn()}
      />
    )
    expect(screen.getByText('Generated image')).toBeVisible()
  })

  it('copies an assistant reply without its visual lines, which mean nothing outside Orca', async () => {
    const writeClipboardText = vi.fn().mockResolvedValue(undefined)
    Object.assign(window, { api: { ui: { writeClipboardText } } })

    render(
      <MessageRow
        message={{
          id: 'message',
          role: 'assistant',
          timestamp: 0,
          source: 'transcript',
          blocks: [
            {
              type: 'text',
              text: 'Here it is.\n\n::orca-visual{file="usage.html" title="Usage"}\n\nDone.'
            }
          ]
        }}
        expandSignal={false}
        onScrollMessageToTop={vi.fn()}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Copy message' }))

    await waitFor(() => {
      expect(writeClipboardText).toHaveBeenCalledWith('Here it is.\n\nDone.')
    })
  })
})

describe('which messages can be quoted', () => {
  it.each([
    ['assistant', 'Message text'],
    ['user', undefined],
    ['system', undefined]
  ] as const)('a selection in a %s message', (role, quoted) => {
    const { container } = renderMessage(role)
    window.getSelection()!.selectAllChildren(screen.getByText('Message text'))

    expect(readNativeChatQuotableSelection(container)?.text).toBe(quoted)
  })
})

describe('what a user message says about its delivery', () => {
  function RecordedMessage({ submission }: { submission: AgentJournalSubmission }) {
    const notices = useStructuredAgentSessionDeliveryNotices({
      pending: [],
      submissions: [submission],
      journalItems: [],
      agentName: 'Codex',
      startFailures: []
    })
    const id = agentJournalSubmissionKey(submission.clientMessageId)
    return (
      <MessageRow
        message={{
          id,
          role: 'user',
          timestamp: 0,
          source: 'transcript',
          blocks: [{ type: 'text', text: 'Ignore failures outside this branch.' }]
        }}
        expandSignal={false}
        onScrollMessageToTop={vi.fn()}
        deliveryNotice={notices.get(id)}
      />
    )
  }

  it('lets a user sign in from the refused message when no composer notice is shown', () => {
    const { signIn } = signInView
    render(
      <NativeChatHostSetupContext.Provider value={setupView}>
        <RecordedMessage
          submission={{
            clientMessageId: 'signed-out',
            fence: 1,
            payloadFingerprint: 'signed-out',
            dispatchState: 'rejected',
            rejection: { kind: 'notSignedIn' },
            providerItemId: null,
            reason: 'Sign in to Pi.',
            submittedAt: 1,
            resolvedAt: 2
          }}
        />
      </NativeChatHostSetupContext.Provider>
    )
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(signIn).toHaveBeenCalledOnce()
  })

  it.each(['accepted', 'rejected', 'unknown'] as const)(
    'keeps a recorded steer Sending through handoff until it becomes %s',
    (dispatchState) => {
      const held: AgentJournalSubmission = {
        clientMessageId: 'steer',
        fence: 1,
        payloadFingerprint: 'steer',
        dispatchState: 'pending',
        providerItemId: null,
        reason: null,
        submittedAt: 1,
        resolvedAt: null,
        handoverRecorded: true
      }
      const { rerender } = render(<RecordedMessage submission={held} />)
      expect(screen.getByText('Sending…')).toBeInTheDocument()
      expect(screen.queryByRole('time')).toBeNull()

      const handedOver = { ...held, handedOverAt: 2 }
      rerender(<RecordedMessage submission={handedOver} />)
      expect(screen.getByText('Sending…')).toBeInTheDocument()

      rerender(
        <RecordedMessage
          submission={{
            ...handedOver,
            dispatchState,
            resolvedAt: 3,
            reason: dispatchState === 'rejected' ? 'Codex refused the message.' : null
          }}
        />
      )
      expect(screen.queryByText('Sending…')).toBeNull()
      expect(screen.getByRole('time')).toBeInTheDocument()
      if (dispatchState === 'rejected') {
        expect(screen.getByText('Codex refused the message.')).toBeInTheDocument()
      }
    }
  )
})
