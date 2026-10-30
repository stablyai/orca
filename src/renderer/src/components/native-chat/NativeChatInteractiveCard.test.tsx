// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { applyCommandMarkerBoundaries } from './native-chat-command-marker'
import type { NativeChatInteractiveSend } from './use-native-chat-interactive-send'

const INITIAL_PROMPT = JSON.stringify({
  questions: [
    {
      question: 'Tabs or spaces?',
      multiSelect: false,
      options: [{ label: 'Tabs' }, { label: 'Spaces' }]
    }
  ]
})

type PaneStatus = {
  interactivePrompt?: string
  toolName?: string
  state?: string
  stateStartedAt?: number
}
const paneStatus: PaneStatus = {
  interactivePrompt: INITIAL_PROMPT,
  toolName: 'AskUserQuestion',
  stateStartedAt: 1
}
const storeState = { agentStatusByPaneKey: { 'tab-1:leaf-1': paneStatus } }

vi.mock('../../store', () => ({
  useAppStore: (selector: (state: typeof storeState) => unknown) => selector(storeState)
}))

import { NativeChatInteractiveCard } from './NativeChatInteractiveCard'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useNativeChatInteractivePromptCard } from './use-native-chat-interactive-prompt-card'
import { useNativeChatPromptCardPresentation } from './use-native-chat-prompt-card-presentation'
import { asyncQuestionSourceScope } from '../../../../shared/native-chat/input/native-chat-ask'
import { useNativeChatAsyncQuestions } from './use-native-chat-async-questions'
import { nativeChatPromptDismissals } from './native-chat-prompt-dismissals'

// Answered occurrences outlive a view by design; each test starts with none.
beforeEach(nativeChatPromptDismissals.clearForTests)

const mocks = {
  sendAnswer: vi.fn<NativeChatInteractiveSend['sendAnswer']>(),
  sendRaw: vi.fn<NativeChatInteractiveSend['sendRaw']>(),
  sendRawVerified: vi.fn<NativeChatInteractiveSend['sendRawVerified']>(),
  cancelPending: vi.fn<NativeChatInteractiveSend['cancelPending']>(),
  cancel: vi.fn<NativeChatInteractiveSend['cancel']>(),
  cancelAsk: vi.fn<NativeChatInteractiveSend['cancelAsk']>()
}

function renderCard(canSend = true): ReturnType<typeof render> {
  return render(cardElement(canSend))
}

const NO_MESSAGES: readonly NativeChatMessage[] = []

function cardElement(
  canSend = true,
  messages?: readonly NativeChatMessage[],
  transcriptSettled = true
): React.JSX.Element {
  return <CardHarness canSend={canSend} messages={messages} transcriptSettled={transcriptSettled} />
}

const SEND: NativeChatInteractiveSend = {
  sendAnswer: mocks.sendAnswer,
  sendRaw: mocks.sendRaw,
  sendRawVerified: mocks.sendRawVerified,
  cancelPending: mocks.cancelPending,
  cancel: mocks.cancel,
  cancelAsk: mocks.cancelAsk
}

describe('terminal-only question presentation', () => {
  beforeEach(() => vi.clearAllMocks())
  afterEach(cleanup)
  it.each([true, false])(
    'replaces answer and cancel controls with terminal navigation (%s)',
    (available) => {
      const onAnswerInTerminal = vi.fn()
      const onDismiss = vi.fn()
      render(
        <NativeChatInteractiveCard
          card={{
            kind: 'question',
            prompt: {
              questions: [{ question: 'Pick', options: [{ label: 'A' }], multiSelect: false }]
            }
          }}
          send={SEND}
          onDismiss={onDismiss}
          requiresTerminal
          onAnswerInTerminal={available ? onAnswerInTerminal : undefined}
        />
      )
      const button = screen.getByRole('button', { name: 'Answer in terminal' })
      expect(screen.getAllByRole('button')).toHaveLength(1)
      expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
      expect(button).toHaveProperty('disabled', !available)
      fireEvent.click(button)
      expect(onAnswerInTerminal).toHaveBeenCalledTimes(available ? 1 : 0)
      expect(mocks.sendAnswer).not.toHaveBeenCalled()
      expect(mocks.cancelAsk).not.toHaveBeenCalled()
      expect(mocks.sendRawVerified).not.toHaveBeenCalled()
      expect(onDismiss).not.toHaveBeenCalled()
    }
  )
})

// Stands in for the view: it derives the shown card and renders it XOR the composer.
function CardHarness({
  canSend,
  messages,
  transcriptSettled,
  targetPtyId = 'pty-1',
  sourceKey = 'transcript/host/session'
}: {
  canSend: boolean
  messages?: readonly NativeChatMessage[]
  transcriptSettled: boolean
  targetPtyId?: string
  sourceKey?: string
}): React.JSX.Element {
  const asyncQuestions = useNativeChatAsyncQuestions({
    paneKey: 'tab-1:leaf-1',
    sourceKey,
    sourceScope: asyncQuestionSourceScope({
      kind: 'transcript',
      agent: 'codex',
      sessionId: 'session',
      transcriptPath: null
    }),
    viewKey: targetPtyId,
    messages: messages ?? NO_MESSAGES,
    settled: transcriptSettled && messages !== undefined
  })
  const card = useNativeChatInteractivePromptCard({
    paneKey: 'tab-1:leaf-1',
    messages: messages ?? NO_MESSAGES,
    transcriptAsk: asyncQuestions.blocking ?? asyncQuestions.prompt,
    transcriptSettled: transcriptSettled && messages !== undefined
  })
  const presentation = useNativeChatPromptCardPresentation({
    paneKey: 'tab-1:leaf-1',
    targetPtyId,
    card,
    dismissAsync: asyncQuestions.dismiss,
    canSend
  })
  return (
    <TooltipProvider>
      {presentation.card ? (
        <NativeChatInteractiveCard
          key={
            presentation.card.kind === 'question' && presentation.card.prompt.replyAsMessage
              ? asyncQuestions.ownerKey
              : (presentation.occurrenceKey ?? 'prompt')
          }
          card={presentation.card}
          onDismiss={presentation.dismiss}
          onCollapse={presentation.collapse}
          send={SEND}
        />
      ) : (
        <div data-testid="composer" />
      )}
    </TooltipProvider>
  )
}

function composerShown(): boolean {
  return screen.queryByTestId('composer') !== null
}

function askCallMessage(question: string): NativeChatMessage {
  return {
    id: `call-${question}`,
    role: 'assistant',
    createdAt: 1,
    blocks: [
      {
        type: 'tool-call',
        name: 'AskUserQuestion',
        input: {
          questions: [
            {
              question,
              header: 'Style',
              multiSelect: false,
              options: [{ label: 'Tabs' }, { label: 'Spaces' }]
            }
          ]
        }
      }
    ]
  } as unknown as NativeChatMessage
}

function askResultMessage(): NativeChatMessage {
  return {
    id: 'result-1',
    role: 'assistant',
    createdAt: 2,
    blocks: [{ type: 'tool-result', name: 'AskUserQuestion', output: 'Tabs' }]
  } as unknown as NativeChatMessage
}

function chooseSpacesAndSubmit(): void {
  fireEvent.click(screen.getByRole('button', { name: /Spaces/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Submit' }))
}

const APPROVAL = JSON.stringify({ approval: { tool: 'Bash', summary: 'rm -rf build' } })

describe('NativeChatInteractiveCard approvals', () => {
  const status = storeState.agentStatusByPaneKey['tab-1:leaf-1']
  beforeEach(() => {
    vi.clearAllMocks()
    status.interactivePrompt = APPROVAL
    status.toolName = undefined
    status.state = 'waiting'
    status.stateStartedAt = 10
  })

  afterEach(() => {
    cleanup()
    status.toolName = 'AskUserQuestion'
  })

  function deferredDelivery(): { settle: (delivered: boolean) => Promise<void> } {
    let resolve: (delivered: boolean) => void = () => {}
    mocks.sendRawVerified.mockReturnValue(
      new Promise<boolean>((done) => {
        resolve = done
      })
    )
    return {
      settle: async (delivered) => {
        await act(async () => resolve(delivered))
      }
    }
  }

  it('ignores approval A settling after answered replacement B', async () => {
    let finishA: (accepted: boolean) => void = () => {}
    mocks.sendRawVerified
      .mockReturnValueOnce(
        new Promise<boolean>((resolve) => {
          finishA = resolve
        })
      )
      .mockResolvedValueOnce(true)
    const view = render(cardElement())
    fireEvent.click(screen.getByRole('button', { name: 'Allow' }))
    status.stateStartedAt = 20
    view.rerender(cardElement())
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Allow' })))
    expect(composerShown()).toBe(true)
    await act(async () => finishA(true))
    expect(composerShown()).toBe(true)
  })

  it('ignores a raw acknowledgment from a rebound PTY', async () => {
    let finishOld: (accepted: boolean) => void = () => {}
    mocks.sendRawVerified.mockReturnValueOnce(
      new Promise<boolean>((resolve) => {
        finishOld = resolve
      })
    )
    const view = render(<CardHarness canSend transcriptSettled targetPtyId="pty-old" />)
    fireEvent.click(screen.getByRole('button', { name: 'Allow' }))
    view.rerender(<CardHarness canSend transcriptSettled targetPtyId="pty-new" />)
    await act(async () => finishOld(true))
    expect(screen.getByRole('button', { name: 'Allow' })).toBeEnabled()
    expect(composerShown()).toBe(false)
  })

  // Why: a composer message typed under an approval lands in the agent's selector.
  it('replaces the composer and hides only once the choice was delivered', async () => {
    const delivery = deferredDelivery()
    render(cardElement())
    expect(screen.getByText('Allow Bash?')).toBeInTheDocument()
    expect(composerShown()).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: 'Allow' }))
    expect(mocks.sendRawVerified).toHaveBeenCalledOnce()
    expect(screen.getByRole('button', { name: 'Deny' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Deny' }))
    expect(mocks.sendRawVerified).toHaveBeenCalledOnce()

    await delivery.settle(true)
    expect(screen.queryByText('Allow Bash?')).not.toBeInTheDocument()
    expect(composerShown()).toBe(true)
  })

  it('keeps the card answerable when the choice was refused or its delivery is unknown', async () => {
    const delivery = deferredDelivery()
    render(cardElement())
    fireEvent.click(screen.getByRole('button', { name: 'Allow' }))
    await delivery.settle(false)

    expect(screen.getByText('Allow Bash?')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Allow' })).toBeEnabled()
    expect(composerShown()).toBe(false)
  })

  it.each(['Escape', 'Collapse'])(
    'collapses the approval on %s without writing, until a new wait shows it again',
    (gesture) => {
      const rendered = render(cardElement())
      if (gesture === 'Escape') {
        fireEvent.keyDown(screen.getByRole('group'), { key: 'Escape' })
      } else {
        fireEvent.click(screen.getByRole('button', { name: 'Collapse' }))
      }
      expect(composerShown()).toBe(true)
      expect(mocks.sendRawVerified).not.toHaveBeenCalled()
      expect(mocks.sendRaw).not.toHaveBeenCalled()

      status.stateStartedAt = 20
      rendered.rerender(cardElement())
      expect(screen.getByText('Allow Bash?')).toBeInTheDocument()
    }
  )

  it('shows a second approval with the same text once it is a new wait', async () => {
    mocks.sendRawVerified.mockResolvedValue(true)
    const rendered = render(cardElement())
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Allow' }))
    })
    // The answered wait lingers in status: still the same occurrence.
    rendered.rerender(cardElement())
    expect(screen.queryByText('Allow Bash?')).not.toBeInTheDocument()

    status.stateStartedAt = 20
    rendered.rerender(cardElement())
    expect(screen.getByText('Allow Bash?')).toBeInTheDocument()
  })

  it('leaves the composer in place while this window may not send', () => {
    render(cardElement(false))
    expect(screen.queryByText('Allow Bash?')).not.toBeInTheDocument()
    expect(composerShown()).toBe(true)
  })
})

describe('NativeChatInteractiveCard answer lifecycle', () => {
  it('routes question Cancel to rejection and releases the composer slot without Stop', async () => {
    mocks.cancelAsk.mockResolvedValue(true)
    render(cardElement())
    expect(screen.getByTestId('native-chat-question-card-title')).toBeInTheDocument()
    expect(composerShown()).toBe(false)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    })
    expect(mocks.cancelAsk).toHaveBeenCalledOnce()
    expect(mocks.cancel).not.toHaveBeenCalled()
    expect(screen.queryByTestId('native-chat-question-card-title')).not.toBeInTheDocument()
    expect(composerShown()).toBe(true)
  })

  it.each(['Escape', 'Collapse'])('collapses the question on %s without writing', (gesture) => {
    render(cardElement())
    if (gesture === 'Escape') {
      fireEvent.keyDown(screen.getByTestId('native-chat-question-card-title'), { key: 'Escape' })
    } else {
      fireEvent.click(screen.getByRole('button', { name: 'Collapse' }))
    }
    expect(composerShown()).toBe(true)
    expect(mocks.cancelAsk).not.toHaveBeenCalled()
    expect(mocks.sendAnswer).not.toHaveBeenCalled()
  })

  it('cannot collapse a question while its answer is still being written', () => {
    mocks.sendAnswer.mockReturnValue({ settleAfterMs: 5_000 })
    render(cardElement())
    chooseSpacesAndSubmit()
    expect(screen.getByRole('button', { name: 'Collapse' })).toBeDisabled()
    fireEvent.keyDown(screen.getByTestId('native-chat-question-card-title'), { key: 'Escape' })
    expect(composerShown()).toBe(false)
    expect(mocks.cancelPending).not.toHaveBeenCalled()
  })

  it('keeps the question when its Cancel was not delivered', async () => {
    mocks.cancelAsk.mockResolvedValue(false)
    render(cardElement())
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    })
    expect(screen.getByTestId('native-chat-question-card-title')).toBeInTheDocument()
    expect(composerShown()).toBe(false)
  })
  beforeEach(() => {
    vi.clearAllMocks()
    storeState.agentStatusByPaneKey['tab-1:leaf-1'].interactivePrompt = INITIAL_PROMPT
    storeState.agentStatusByPaneKey['tab-1:leaf-1'].state = undefined
  })

  afterEach(() => {
    cleanup()
  })

  it('keeps the card retryable when no PTY answer was sent', () => {
    mocks.sendAnswer.mockReturnValue({ settleAfterMs: 0 })
    renderCard()

    chooseSpacesAndSubmit()
    expect(screen.getByText('Tabs or spaces?')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Submit' }))
    expect(mocks.sendAnswer).toHaveBeenCalledTimes(2)
  })

  it('cancels delayed PTY writes when the owning card unmounts', () => {
    mocks.sendAnswer.mockReturnValue({ settleAfterMs: 5_000 })
    const rendered = renderCard()

    chooseSpacesAndSubmit()
    expect(mocks.cancelPending).not.toHaveBeenCalled()

    rendered.unmount()
    expect(mocks.cancelPending).toHaveBeenCalledOnce()
  })

  it('cancels delayed PTY writes when desktop send authority is lost', () => {
    mocks.sendAnswer.mockReturnValue({ settleAfterMs: 5_000 })
    const rendered = renderCard()

    chooseSpacesAndSubmit()
    rendered.rerender(cardElement(false))

    expect(mocks.cancelPending).toHaveBeenCalledOnce()
  })

  it('shows the paced send as busy and freezes the snapshotted answer', () => {
    mocks.sendAnswer.mockReturnValue({ settleAfterMs: 5_000 })
    renderCard()

    chooseSpacesAndSubmit()

    expect(screen.getByRole('button', { name: 'Sending…' })).toBeDisabled()
    expect(screen.getByRole('button', { name: /Spaces/ })).toBeDisabled()
    expect(screen.getByRole('textbox')).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled()
  })

  it('cancels the old answer sequence when a replacement prompt arrives', () => {
    mocks.sendAnswer.mockReturnValue({ settleAfterMs: 5_000 })
    const rendered = renderCard()
    chooseSpacesAndSubmit()

    storeState.agentStatusByPaneKey['tab-1:leaf-1'].interactivePrompt = JSON.stringify({
      questions: [
        {
          question: 'Choose a shell?',
          multiSelect: false,
          options: [{ label: 'zsh' }, { label: 'bash' }]
        }
      ]
    })
    rendered.rerender(cardElement())

    expect(mocks.cancelPending).toHaveBeenCalledOnce()
    expect(screen.getByText('Choose a shell?')).toBeInTheDocument()
  })

  it('sends only one cancellation, can cancel an answer, and permits retry after unknown', async () => {
    let finishCancel: (accepted: boolean) => void = () => {}
    let finishAnswer: ((accepted: boolean) => void) | undefined
    mocks.sendAnswer.mockImplementation((_prompt, _selections, settled) => {
      finishAnswer = settled
      return { settleAfterMs: 500 }
    })
    mocks.cancelAsk
      .mockReturnValueOnce(
        new Promise<boolean>((resolve) => {
          finishCancel = resolve
        })
      )
      .mockResolvedValueOnce(true)
    renderCard()
    chooseSpacesAndSubmit()
    const cancel = screen.getByRole('button', { name: 'Cancel' })
    expect(cancel).toBeEnabled()
    fireEvent.click(cancel)
    expect(cancel).toBeDisabled()
    fireEvent.click(cancel)
    expect(mocks.cancelAsk).toHaveBeenCalledOnce()
    act(() => finishAnswer?.(true))
    expect(composerShown()).toBe(false)
    await act(async () => finishCancel(false))
    expect(cancel).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Submit' })).toBeEnabled()
    await act(async () => fireEvent.click(cancel))
    expect(mocks.cancelAsk).toHaveBeenCalledTimes(2)
    expect(composerShown()).toBe(true)
  })

  it('keeps a verified send visible until delivery succeeds', () => {
    let settleDelivery: ((delivered: boolean) => void) | undefined
    mocks.sendAnswer.mockImplementation((_prompt, _selections, onDeliverySettled) => {
      settleDelivery = onDeliverySettled
      return { settleAfterMs: 500 }
    })
    renderCard()

    chooseSpacesAndSubmit()
    expect(screen.getByRole('button', { name: 'Sending…' })).toBeDisabled()

    act(() => settleDelivery?.(true))
    expect(screen.queryByText('Tabs or spaces?')).not.toBeInTheDocument()
  })

  it('restores a verified send for retry when delivery is rejected', () => {
    let settleDelivery: ((delivered: boolean) => void) | undefined
    mocks.sendAnswer.mockImplementation((_prompt, _selections, onDeliverySettled) => {
      settleDelivery = onDeliverySettled
      return { settleAfterMs: 500 }
    })
    renderCard()

    chooseSpacesAndSubmit()
    act(() => settleDelivery?.(false))

    expect(screen.getByRole('button', { name: 'Submit' })).toBeEnabled()
    expect(screen.getByText('Tabs or spaces?')).toBeInTheDocument()
  })
})

// Transcript fallback covers missing live prompts; native-chat-ask.test.ts owns pending-call parsing.
describe('NativeChatInteractiveCard transcript fallback', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    storeState.agentStatusByPaneKey['tab-1:leaf-1'].interactivePrompt = undefined
    storeState.agentStatusByPaneKey['tab-1:leaf-1'].state = undefined
  })

  afterEach(() => {
    cleanup()
  })

  it('renders a pending transcript ask in place of the composer', () => {
    render(cardElement(true, [askCallMessage('Tabs or spaces?')]))

    expect(screen.getByText('Tabs or spaces?')).toBeInTheDocument()
    expect(composerShown()).toBe(false)
  })

  it('withholds a retained transcript ask while its replacement read is unsettled', () => {
    render(cardElement(true, [askCallMessage('Stale transcript question?')], false))

    expect(screen.queryByText('Stale transcript question?')).not.toBeInTheDocument()
  })

  it('prefers live status over the transcript when both carry a prompt', () => {
    storeState.agentStatusByPaneKey['tab-1:leaf-1'].interactivePrompt = INITIAL_PROMPT
    render(cardElement(true, [askCallMessage('Stale transcript question?')]))

    expect(screen.getByText('Tabs or spaces?')).toBeInTheDocument()
    expect(screen.queryByText('Stale transcript question?')).not.toBeInTheDocument()
  })

  it('still renders while the mirrored status says the agent is working', () => {
    // Mirrored status can fail independently of the transcript, so it cannot gate fallback prompts.
    storeState.agentStatusByPaneKey['tab-1:leaf-1'].state = 'working'
    render(cardElement(true, [askCallMessage('Tabs or spaces?')]))

    expect(screen.getByText('Tabs or spaces?')).toBeInTheDocument()
  })

  it('stays dismissed after answering while the transcript call is still pending', () => {
    mocks.sendAnswer.mockReturnValue({ settleAfterMs: 500 })
    const messages = [askCallMessage('Tabs or spaces?')]
    const rendered = render(cardElement(true, messages))

    let settleDelivery: ((delivered: boolean) => void) | undefined
    mocks.sendAnswer.mockImplementation((_prompt, _selections, onDeliverySettled) => {
      settleDelivery = onDeliverySettled
      return { settleAfterMs: 500 }
    })
    chooseSpacesAndSubmit()
    act(() => settleDelivery?.(true))
    rendered.rerender(cardElement(true, messages))

    expect(screen.queryByText('Tabs or spaces?')).not.toBeInTheDocument()
  })

  it('clears once the FIFO tool result lands', () => {
    const rendered = render(cardElement(true, [askCallMessage('Tabs or spaces?')]))
    expect(screen.getByText('Tabs or spaces?')).toBeInTheDocument()

    rendered.rerender(cardElement(true, [askCallMessage('Tabs or spaces?'), askResultMessage()]))
    expect(screen.queryByText('Tabs or spaces?')).not.toBeInTheDocument()
  })

  it('drops an ask abandoned by /clear', () => {
    const abandoned = { ...askCallMessage('Tabs or spaces?'), timestamp: 100 }
    const trimmed = applyCommandMarkerBoundaries(
      [abandoned as unknown as NativeChatMessage],
      [{ id: 'clear-1', command: '/clear', sentAt: 200 }]
    )
    render(cardElement(true, trimmed))

    expect(screen.queryByText('Tabs or spaces?')).not.toBeInTheDocument()
  })
})

describe('terminal async contributors through the production hooks and card', () => {
  const row = (id: string, title: string): NativeChatMessage => ({
    id,
    role: 'assistant',
    timestamp: null,
    source: 'transcript',
    blocks: [
      {
        type: 'tool-call',
        name: 'request_user_input_async',
        input: { questions: [{ title, options: ['Tabs', 'Spaces'] }] }
      }
    ]
  })
  beforeEach(() => {
    vi.clearAllMocks()
    paneStatus.interactivePrompt = undefined
    paneStatus.toolName = undefined
    paneStatus.state = 'done'
  })
  afterEach(cleanup)

  it('retains terminal choices across an agent notice until legacy human input', () => {
    const q1 = row('one', 'Q1?')
    const notice: NativeChatMessage = {
      id: 'mail',
      role: 'user',
      timestamp: 2,
      source: 'transcript',
      blocks: [{ type: 'text', text: 'You have 1 orchestration message.' }],
      from: {
        kind: 'agent',
        senders: [
          {
            party: { address: 'term_a', terminalHandle: 'term_a', orcaSessionId: null },
            name: 'Coder'
          }
        ],
        orchestration: {
          message: 'mail-notice',
          mailbox: 'term_b',
          dispatchId: null,
          messages: [{ messageId: 'mail-1', runId: 'run-1', from: 'term_a' }]
        }
      }
    }
    const view = render(cardElement(true, [q1]))
    fireEvent.click(screen.getByRole('button', { name: /Spaces/ }))
    view.rerender(cardElement(true, [q1, notice]))
    expect(screen.getByText('Q1?')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Spaces/ })).toHaveAttribute('aria-pressed', 'true')
    view.rerender(cardElement(true, [q1, notice, { ...notice, id: 'human', from: undefined }]))
    expect(composerShown()).toBe(true)
    expect(mocks.sendAnswer).not.toHaveBeenCalled()
  })

  it('filters Q1 before grouping Q2 and never writes Cancel, including window movement', () => {
    const q1 = row('one', 'Q1?')
    const q2 = row('two', 'Q2?')
    const view = render(cardElement(true, [q1]))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    view.rerender(cardElement(true, [q1, q2]))
    expect(screen.queryByText('Q1?')).not.toBeInTheDocument()
    expect(screen.getByText('Q2?')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    view.rerender(cardElement(true, []))
    view.rerender(cardElement(true, [row('one', 'Edited Q1?'), q2]))
    expect(composerShown()).toBe(true)
    expect(mocks.cancelAsk).not.toHaveBeenCalled()
    expect(mocks.cancel).not.toHaveBeenCalled()
    expect(mocks.sendRawVerified).not.toHaveBeenCalled()
    // Async hides cannot refuse a live blocking prompt with the same definition.
    paneStatus.interactivePrompt = JSON.stringify({
      questions: [{ question: 'Q1?', options: ['Tabs', 'Spaces'] }]
    })
    view.rerender(cardElement(true, [q1, q2]))
    expect(screen.getByText('Q1?')).toBeInTheDocument()
  })

  it.each(['same-owner', 'source', 'PTY'])(
    'captures answered Q1 IDs while Q2 arrives (%s)',
    (replacement) => {
      let finish: (delivered: boolean) => void = () => {
        throw new Error('not submitted')
      }
      mocks.sendAnswer.mockImplementation((_prompt, _selections, done) => {
        finish = done!
        return { settleAfterMs: 500 }
      })
      const q1 = row('one', 'Q1?')
      const q2 = row('two', 'Q2?')
      const element = (
        messages: NativeChatMessage[],
        sourceKey = 'transcript/host/session',
        targetPtyId = 'pty-1'
      ) => (
        <CardHarness
          canSend
          transcriptSettled
          messages={messages}
          sourceKey={sourceKey}
          targetPtyId={targetPtyId}
        />
      )
      const view = render(element([q1]))
      chooseSpacesAndSubmit()
      view.rerender(
        element(
          [q1, q2],
          replacement === 'source' ? 'transcript/other/session' : undefined,
          replacement === 'PTY' ? 'pty-2' : undefined
        )
      )
      act(() => finish(true))
      if (replacement === 'same-owner') {
        expect(screen.getByText('Q2?')).toBeInTheDocument()
        expect(screen.queryByText('Q1?')).not.toBeInTheDocument()
      } else {
        expect(screen.getByText('Q1?')).toBeInTheDocument()
      }
    }
  )

  it('resets an edited pending form without unmounting its answer owner', () => {
    const view = render(cardElement(true, [row('one', 'Q1?')]))
    fireEvent.click(screen.getByRole('button', { name: /Spaces/ }))
    expect(screen.getByRole('button', { name: /Spaces/ })).toHaveAttribute('aria-pressed', 'true')
    view.rerender(cardElement(true, [row('one', 'Revised Q1?')]))
    expect(screen.getByRole('button', { name: /Spaces/ })).toHaveAttribute('aria-pressed', 'false')
    expect(mocks.cancelPending).not.toHaveBeenCalled()
  })
})
