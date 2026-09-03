// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { applyCommandMarkerBoundaries } from './native-chat-command-marker'
import { nativeChatAnswerConfirmDeadlineMs } from './native-chat-answer-confirmation'
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

const storeState = {
  agentStatusByPaneKey: {
    'tab-1:leaf-1': {
      interactivePrompt: INITIAL_PROMPT as string | undefined,
      toolName: 'AskUserQuestion' as string | undefined,
      state: undefined as string | undefined
    }
  }
}

vi.mock('../../store', () => ({
  useAppStore: (selector: (state: typeof storeState) => unknown) => selector(storeState)
}))

import { NativeChatInteractiveCard } from './NativeChatInteractiveCard'

const mocks = {
  sendAnswer: vi.fn<NativeChatInteractiveSend['sendAnswer']>(),
  sendRaw: vi.fn<NativeChatInteractiveSend['sendRaw']>(),
  cancelPending: vi.fn<NativeChatInteractiveSend['cancelPending']>(),
  cancel: vi.fn<NativeChatInteractiveSend['cancel']>(),
  /** Clears the pane's question wait; the card owes it a confirmation signal. */
  confirmAnswered: vi.fn<() => void>()
}

function sendResult(
  settleAfterMs: number,
  waitsForVerifiedDelivery: boolean
): ReturnType<NativeChatInteractiveSend['sendAnswer']> {
  return { settleAfterMs, waitsForVerifiedDelivery, confirmAnswered: mocks.confirmAnswered }
}

function renderCard(canSend = true): ReturnType<typeof render> {
  return render(cardElement(canSend))
}

function cardElement(
  canSend = true,
  messages?: readonly NativeChatMessage[],
  onShowingQuestionChange?: (showing: boolean) => void,
  transcriptSettled = true
): React.JSX.Element {
  return (
    <NativeChatInteractiveCard
      paneKey="tab-1:leaf-1"
      canSend={canSend}
      messages={messages}
      transcriptSettled={transcriptSettled}
      onShowingQuestionChange={onShowingQuestionChange}
      send={{
        sendAnswer: mocks.sendAnswer,
        sendRaw: mocks.sendRaw,
        cancelPending: mocks.cancelPending,
        cancel: mocks.cancel
      }}
    />
  )
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

/** The transcript tool-call for the live `INITIAL_PROMPT` question — same
 *  canonical content, as a real session emits for one AskUserQuestion. */
function initialPromptCallMessage(): NativeChatMessage {
  return {
    id: 'call-initial',
    role: 'assistant',
    createdAt: 1,
    blocks: [{ type: 'tool-call', name: 'AskUserQuestion', input: JSON.parse(INITIAL_PROMPT) }]
  } as unknown as NativeChatMessage
}

function chooseSpacesAndSubmit(): void {
  fireEvent.click(screen.getByRole('button', { name: /Spaces/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Submit' }))
}

describe('NativeChatInteractiveCard answer lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    storeState.agentStatusByPaneKey['tab-1:leaf-1'].interactivePrompt = INITIAL_PROMPT
    storeState.agentStatusByPaneKey['tab-1:leaf-1'].state = undefined
  })

  afterEach(() => {
    cleanup()
  })

  it('keeps the card retryable when no PTY answer was sent', () => {
    mocks.sendAnswer.mockReturnValue(sendResult(0, false))
    renderCard()

    chooseSpacesAndSubmit()
    expect(screen.getByText('Tabs or spaces?')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Submit' }))
    expect(mocks.sendAnswer).toHaveBeenCalledTimes(2)
  })

  it('cancels delayed PTY writes when the owning card unmounts', () => {
    mocks.sendAnswer.mockReturnValue(sendResult(5_000, false))
    const rendered = renderCard()

    chooseSpacesAndSubmit()
    expect(mocks.cancelPending).not.toHaveBeenCalled()

    rendered.unmount()
    expect(mocks.cancelPending).toHaveBeenCalledOnce()
  })

  it('cancels delayed PTY writes when desktop send authority is lost', () => {
    mocks.sendAnswer.mockReturnValue(sendResult(5_000, false))
    const rendered = renderCard()

    chooseSpacesAndSubmit()
    rendered.rerender(cardElement(false))

    expect(mocks.cancelPending).toHaveBeenCalledOnce()
  })

  it('shows the paced send as busy and freezes the snapshotted answer', () => {
    mocks.sendAnswer.mockReturnValue(sendResult(5_000, false))
    renderCard()

    chooseSpacesAndSubmit()

    expect(screen.getByRole('button', { name: 'Sending…' })).toBeDisabled()
    expect(screen.getByRole('button', { name: /Spaces/ })).toBeDisabled()
    expect(screen.getByRole('textbox')).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled()
  })

  it('cancels the old answer sequence when a replacement prompt arrives', () => {
    mocks.sendAnswer.mockReturnValue(sendResult(5_000, false))
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

  it('keeps a verified send visible until delivery succeeds', () => {
    let settleDelivery: ((delivered: boolean) => void) | undefined
    mocks.sendAnswer.mockImplementation((_prompt, _selections, onDeliverySettled) => {
      settleDelivery = onDeliverySettled
      return sendResult(500, true)
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
      return sendResult(500, true)
    })
    renderCard()

    chooseSpacesAndSubmit()
    act(() => settleDelivery?.(false))

    expect(screen.getByRole('button', { name: 'Submit' })).toBeEnabled()
    expect(screen.getByText('Tabs or spaces?')).toBeInTheDocument()
  })
})

// A headless host, a relay gap, or a replay can leave the pane with no live
// `interactivePrompt` while the transcript still holds the unresolved call (#11761).
// Which asks the transcript still counts as pending (orphaned calls, turn boundaries)
// is the shared parser's contract — covered in `src/shared/native-chat-ask.test.ts`.
// Delivering an answer proves only that the PTY took the bytes. A selector the
// keystrokes do not fit (preview-style layouts, for months) leaves the question
// live, and the pre-fix card dismissed into a false "working" animation with no
// way back (#16865).
describe('NativeChatInteractiveCard unconfirmed answers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    storeState.agentStatusByPaneKey['tab-1:leaf-1'].interactivePrompt = INITIAL_PROMPT
    storeState.agentStatusByPaneKey['tab-1:leaf-1'].state = undefined
  })

  afterEach(() => {
    vi.useRealTimers()
    cleanup()
  })

  function answerWithVerifiedDelivery(): void {
    let settleDelivery: ((delivered: boolean) => void) | undefined
    mocks.sendAnswer.mockImplementation((_prompt, _selections, onDeliverySettled) => {
      settleDelivery = onDeliverySettled
      return sendResult(500, true)
    })
    renderCard()
    chooseSpacesAndSubmit()
    act(() => settleDelivery?.(true))
  }

  it('brings the question back when no confirmation arrives before the deadline', () => {
    answerWithVerifiedDelivery()
    expect(screen.queryByText('Tabs or spaces?')).not.toBeInTheDocument()

    act(() => {
      vi.advanceTimersByTime(nativeChatAnswerConfirmDeadlineMs(500))
    })

    expect(screen.getByText('Tabs or spaces?')).toBeInTheDocument()
    // Answerable again, not a frozen "Sending…" shell.
    expect(screen.getByRole('button', { name: /Spaces/ })).toBeEnabled()
  })

  it('leaves the pane waiting while an answer is unconfirmed', () => {
    answerWithVerifiedDelivery()

    act(() => {
      vi.advanceTimersByTime(nativeChatAnswerConfirmDeadlineMs(500))
    })

    // The question is still live, so the wait must survive: clearing it is what
    // painted a progress animation over a blocked session.
    expect(mocks.confirmAnswered).not.toHaveBeenCalled()
  })

  it('holds the card dismissed right up to the deadline', () => {
    answerWithVerifiedDelivery()

    act(() => {
      vi.advanceTimersByTime(nativeChatAnswerConfirmDeadlineMs(500) - 1)
    })

    expect(screen.queryByText('Tabs or spaces?')).not.toBeInTheDocument()
  })

  it('scales the deadline with the keystroke pacing of a longer answer', () => {
    let settleDelivery: ((delivered: boolean) => void) | undefined
    mocks.sendAnswer.mockImplementation((_prompt, _selections, onDeliverySettled) => {
      settleDelivery = onDeliverySettled
      return sendResult(6_000, true)
    })
    renderCard()
    chooseSpacesAndSubmit()
    act(() => settleDelivery?.(true))

    // A short answer's deadline would already have fired here; a paced one has
    // not finished writing its groups yet, so the card must stay down.
    act(() => {
      vi.advanceTimersByTime(nativeChatAnswerConfirmDeadlineMs(500))
    })
    expect(screen.queryByText('Tabs or spaces?')).not.toBeInTheDocument()

    act(() => {
      vi.advanceTimersByTime(nativeChatAnswerConfirmDeadlineMs(6_000))
    })
    expect(screen.getByText('Tabs or spaces?')).toBeInTheDocument()
  })

  it('confirms the answer and keeps the card down once the prompt clears', () => {
    let settleDelivery: ((delivered: boolean) => void) | undefined
    mocks.sendAnswer.mockImplementation((_prompt, _selections, onDeliverySettled) => {
      settleDelivery = onDeliverySettled
      return sendResult(500, true)
    })
    const rendered = renderCard()
    chooseSpacesAndSubmit()
    act(() => settleDelivery?.(true))

    // A fresh hook status drops the prompt: the agent moved on, so the answer landed.
    storeState.agentStatusByPaneKey['tab-1:leaf-1'].interactivePrompt = undefined
    rendered.rerender(cardElement())

    expect(mocks.confirmAnswered).toHaveBeenCalledOnce()
    act(() => {
      vi.advanceTimersByTime(nativeChatAnswerConfirmDeadlineMs(500))
    })
    expect(screen.queryByText('Tabs or spaces?')).not.toBeInTheDocument()
  })

  it('treats a replacement question as confirmation of the answered one', () => {
    let settleDelivery: ((delivered: boolean) => void) | undefined
    mocks.sendAnswer.mockImplementation((_prompt, _selections, onDeliverySettled) => {
      settleDelivery = onDeliverySettled
      return sendResult(500, true)
    })
    const rendered = renderCard()
    chooseSpacesAndSubmit()
    act(() => settleDelivery?.(true))

    storeState.agentStatusByPaneKey['tab-1:leaf-1'].interactivePrompt = JSON.stringify({
      questions: [{ question: 'Choose a shell?', multiSelect: false, options: [{ label: 'zsh' }] }]
    })
    rendered.rerender(cardElement())

    expect(mocks.confirmAnswered).toHaveBeenCalledOnce()
    expect(screen.getByText('Choose a shell?')).toBeInTheDocument()
  })

  it('does not resurrect a question the user cancelled', () => {
    mocks.sendAnswer.mockReturnValue(sendResult(500, true))
    renderCard()

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    act(() => {
      vi.advanceTimersByTime(nativeChatAnswerConfirmDeadlineMs(500))
    })

    expect(screen.queryByText('Tabs or spaces?')).not.toBeInTheDocument()
    expect(mocks.confirmAnswered).not.toHaveBeenCalled()
  })

  // A question killed inside the TUI (selector ESC, or the card's X sending a
  // real ESC byte) emits no hook, so live status keeps asserting it. Before the
  // liveness check the deadline restored the card over a dead question, and
  // answering it typed option digits into the bare composer (#16865).
  it('does not resurrect a question the transcript shows already resolved', () => {
    let settleDelivery: ((delivered: boolean) => void) | undefined
    mocks.sendAnswer.mockImplementation((_prompt, _selections, onDeliverySettled) => {
      settleDelivery = onDeliverySettled
      return sendResult(500, true)
    })
    const messages = [initialPromptCallMessage()]
    const rendered = render(cardElement(true, messages))
    chooseSpacesAndSubmit()
    act(() => settleDelivery?.(true))

    // Live status still holds the dead question; only the transcript knows.
    rendered.rerender(cardElement(true, [...messages, askResultMessage()]))
    act(() => {
      vi.advanceTimersByTime(nativeChatAnswerConfirmDeadlineMs(500))
    })

    expect(screen.queryByText('Tabs or spaces?')).not.toBeInTheDocument()
  })

  it('drops the remaining keystrokes when the ask dies mid-send', () => {
    mocks.sendAnswer.mockReturnValue(sendResult(6_000, true))
    const messages = [initialPromptCallMessage()]
    const rendered = render(cardElement(true, messages))
    chooseSpacesAndSubmit()
    expect(mocks.cancelPending).not.toHaveBeenCalled()

    // The selector dies between paced keystroke groups.
    rendered.rerender(cardElement(true, [...messages, askResultMessage()]))

    expect(mocks.cancelPending).toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'Sending…' })).not.toBeInTheDocument()
  })

  // The plain-selector flow commits on a digit and its hook event follows
  // shortly; the optimistic dismissal must survive unchanged.
  it('keeps an unverified paced answer dismissed once its hook status lands', () => {
    mocks.sendAnswer.mockReturnValue(sendResult(500, false))
    const rendered = renderCard()
    chooseSpacesAndSubmit()

    act(() => {
      vi.advanceTimersByTime(500)
    })
    expect(screen.queryByText('Tabs or spaces?')).not.toBeInTheDocument()

    storeState.agentStatusByPaneKey['tab-1:leaf-1'].interactivePrompt = undefined
    rendered.rerender(cardElement())

    expect(mocks.confirmAnswered).toHaveBeenCalledOnce()
  })
})

describe('NativeChatInteractiveCard transcript fallback', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    storeState.agentStatusByPaneKey['tab-1:leaf-1'].interactivePrompt = undefined
    storeState.agentStatusByPaneKey['tab-1:leaf-1'].state = undefined
  })

  afterEach(() => {
    cleanup()
  })

  it('renders a pending transcript ask and reports the composer replacement', () => {
    const onShowingQuestionChange = vi.fn()
    render(cardElement(true, [askCallMessage('Tabs or spaces?')], onShowingQuestionChange))

    expect(screen.getByText('Tabs or spaces?')).toBeInTheDocument()
    expect(onShowingQuestionChange).toHaveBeenCalledWith(true)
  })

  it('withholds a retained transcript ask while its replacement read is unsettled', () => {
    render(cardElement(true, [askCallMessage('Stale transcript question?')], undefined, false))

    expect(screen.queryByText('Stale transcript question?')).not.toBeInTheDocument()
  })

  it('prefers live status over the transcript when both carry a prompt', () => {
    storeState.agentStatusByPaneKey['tab-1:leaf-1'].interactivePrompt = INITIAL_PROMPT
    render(cardElement(true, [askCallMessage('Stale transcript question?')]))

    expect(screen.getByText('Tabs or spaces?')).toBeInTheDocument()
    expect(screen.queryByText('Stale transcript question?')).not.toBeInTheDocument()
  })

  it('still renders while the mirrored status says the agent is working', () => {
    // Why no state gate: the mirrored status channel is exactly what fails in the
    // reported topology, so keying the fallback on it would suppress the card.
    storeState.agentStatusByPaneKey['tab-1:leaf-1'].state = 'working'
    render(cardElement(true, [askCallMessage('Tabs or spaces?')]))

    expect(screen.getByText('Tabs or spaces?')).toBeInTheDocument()
  })

  it('stays dismissed after answering while the transcript call is still pending', () => {
    mocks.sendAnswer.mockReturnValue(sendResult(500, true))
    const messages = [askCallMessage('Tabs or spaces?')]
    const rendered = render(cardElement(true, messages))

    let settleDelivery: ((delivered: boolean) => void) | undefined
    mocks.sendAnswer.mockImplementation((_prompt, _selections, onDeliverySettled) => {
      settleDelivery = onDeliverySettled
      return sendResult(500, true)
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

  // The view passes the command-boundary-trimmed messages, so an ask abandoned via
  // `/clear` cannot come back as a permanent card sitting over the composer.
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
