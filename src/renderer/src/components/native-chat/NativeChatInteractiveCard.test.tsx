// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
      interactivePrompt: INITIAL_PROMPT,
      toolName: 'AskUserQuestion'
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
  cancel: vi.fn<NativeChatInteractiveSend['cancel']>()
}

function renderCard(canSend = true): ReturnType<typeof render> {
  return render(cardElement(canSend))
}

function cardElement(canSend = true): React.JSX.Element {
  return (
    <NativeChatInteractiveCard
      paneKey="tab-1:leaf-1"
      canSend={canSend}
      send={{
        sendAnswer: mocks.sendAnswer,
        sendRaw: mocks.sendRaw,
        cancelPending: mocks.cancelPending,
        cancel: mocks.cancel
      }}
    />
  )
}

function chooseSpacesAndSubmit(): void {
  fireEvent.click(screen.getByRole('button', { name: /Spaces/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Send answer' }))
}

describe('NativeChatInteractiveCard answer lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    storeState.agentStatusByPaneKey['tab-1:leaf-1'].interactivePrompt = INITIAL_PROMPT
  })

  afterEach(() => {
    cleanup()
  })

  it('keeps the card retryable when no PTY answer was sent', () => {
    mocks.sendAnswer.mockReturnValue({ settleAfterMs: 0, waitsForVerifiedDelivery: false })
    renderCard()

    chooseSpacesAndSubmit()
    expect(screen.getByText('Tabs or spaces?')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Send answer' }))
    expect(mocks.sendAnswer).toHaveBeenCalledTimes(2)
  })

  it('cancels delayed PTY writes when the owning card unmounts', () => {
    mocks.sendAnswer.mockReturnValue({ settleAfterMs: 5_000, waitsForVerifiedDelivery: false })
    const rendered = renderCard()

    chooseSpacesAndSubmit()
    expect(mocks.cancelPending).not.toHaveBeenCalled()

    rendered.unmount()
    expect(mocks.cancelPending).toHaveBeenCalledOnce()
  })

  it('cancels delayed PTY writes when desktop send authority is lost', () => {
    mocks.sendAnswer.mockReturnValue({ settleAfterMs: 5_000, waitsForVerifiedDelivery: false })
    const rendered = renderCard()

    chooseSpacesAndSubmit()
    rendered.rerender(cardElement(false))

    expect(mocks.cancelPending).toHaveBeenCalledOnce()
  })

  it('shows the paced send as busy and freezes the snapshotted answer', () => {
    mocks.sendAnswer.mockReturnValue({ settleAfterMs: 5_000, waitsForVerifiedDelivery: false })
    renderCard()

    chooseSpacesAndSubmit()

    expect(screen.getByRole('button', { name: 'Sending…' })).toBeDisabled()
    expect(screen.getByRole('button', { name: /Spaces/ })).toBeDisabled()
    expect(screen.getByRole('textbox')).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled()
  })

  it('cancels the old answer sequence when a replacement prompt arrives', () => {
    mocks.sendAnswer.mockReturnValue({ settleAfterMs: 5_000, waitsForVerifiedDelivery: false })
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
      return { settleAfterMs: 500, waitsForVerifiedDelivery: true }
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
      return { settleAfterMs: 500, waitsForVerifiedDelivery: true }
    })
    renderCard()

    chooseSpacesAndSubmit()
    act(() => settleDelivery?.(false))

    expect(screen.getByRole('button', { name: 'Send answer' })).toBeEnabled()
    expect(screen.getByText('Tabs or spaces?')).toBeInTheDocument()
  })
})
