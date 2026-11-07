// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../../../shared/native-chat/native-chat-types'

import type { NativeChatInteractiveSend } from '../session/terminal/send/use-native-chat-interactive-send'

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

vi.mock('../../../store/index', () => ({
  useAppStore: (selector: (state: typeof storeState) => unknown) => selector(storeState)
}))

import { NativeChatInteractiveCard } from './NativeChatInteractiveCard'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useNativeChatInteractivePromptCard } from './use-native-chat-interactive-prompt-card'
import { useNativeChatPromptCardPresentation } from './use-native-chat-prompt-card-presentation'
import { asyncQuestionSourceScope } from '../../../../../shared/native-chat/input/native-chat-ask'
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
})

describe('NativeChatInteractiveCard answer lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    storeState.agentStatusByPaneKey['tab-1:leaf-1'].interactivePrompt = INITIAL_PROMPT
    storeState.agentStatusByPaneKey['tab-1:leaf-1'].state = undefined
  })

  afterEach(() => {
    cleanup()
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
})
