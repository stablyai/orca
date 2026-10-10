// @vitest-environment happy-dom

// What a message sent over a held queue asks about: offered exactly while the header row shows,
// counting every card shown, and Clear queue deletes each of them through the card's own Delete.

import { act, render, renderHook, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { setRendererUiLanguage } from '@/i18n/i18n'
import type {
  AgentSessionQueuedMessage,
  AgentSessionQueuePause
} from '../../../../shared/agent-session-wire'
import { useStructuredAgentSessionQueuedMessages } from './use-structured-agent-session-queued-messages'
import type { StructuredAgentSessionMutate } from './use-structured-agent-session-mutate'
import { NativeChatQueueSendConfirmDialog } from './NativeChatQueueSendConfirmDialog'
import type { QueuedEditTransport } from './use-structured-agent-session-queued-edit'

const NO_EDIT: QueuedEditTransport = {
  target: { kind: 'local' },
  sessionId: 'session',
  capable: false,
  write: async () => ({ kind: 'dropped' })
}

const STOPPED = { reason: 'stopped' } as const

function card(
  messageId: string,
  position: number,
  fields: Partial<AgentSessionQueuedMessage> = {}
): AgentSessionQueuedMessage {
  const body = { kind: 'message' as const, role: 'user' as const, blocks: [] }
  return { messageId, position, body, state: 'waiting', ...fields }
}

type DeleteAnswer = { deleted: true; messageId: string } | null

function renderController(
  queuedMessages: AgentSessionQueuedMessage[],
  options: {
    queuePause?: AgentSessionQueuePause | null
    enabled?: boolean
    isWorking?: boolean
    answer?: (messageId: string) => DeleteAnswer
  } = {}
) {
  const answer = options.answer ?? ((messageId) => ({ deleted: true, messageId }))
  const mutate = vi.fn(
    async (_method: string, _fingerprint: string, fields: Record<string, unknown>) =>
      answer(String(fields.messageId))
  )
  const view = renderHook(() =>
    useStructuredAgentSessionQueuedMessages({
      enabled: options.enabled ?? true,
      queuedMessages,
      queuePause: options.queuePause === undefined ? STOPPED : options.queuePause,
      submissions: [],
      hasPendingPrompt: false,
      isWorking: options.isWorking === true,
      composerScopeKey: undefined,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the controller only awaits mutate; the stub answers Delete's shape.
      mutate: mutate as unknown as StructuredAgentSessionMutate,
      editTransport: NO_EDIT
    })
  )
  return { ...view, mutate }
}

afterEach(async () => {
  vi.clearAllMocks()
  await setRendererUiLanguage('en')
})

describe('the held queue a new message asks about', () => {
  it('is offered while a pause holds a card, counting every card shown, held or not', () => {
    const { result } = renderController([
      card('held', 1),
      card('typed-after', 2),
      card('failed', 3, { paused: true, pausedReason: 'send_failed' })
    ])
    expect(result.current.pause).toEqual(STOPPED)
    expect(result.current.queueHold?.count).toBe(3)
  })

  it('is not offered when no pause holds a card, with no cards, or without the queue', () => {
    const unheld = [card('waiting', 1)]
    expect(renderController(unheld, { queuePause: null }).result.current.queueHold).toBeUndefined()
    const ownHeld = [card('failed', 1, { paused: true })]
    expect(renderController(ownHeld).result.current.queueHold).toBeUndefined()
    expect(renderController([]).result.current.queueHold).toBeUndefined()
    const held = [card('held', 1)]
    expect(renderController(held, { enabled: false }).result.current.queueHold).toBeUndefined()
  })

  it('is not offered while a turn runs, though the paused row shows as the Stop winds down', () => {
    const held = [card('held', 1)]
    const { result } = renderController(held, { isWorking: true })
    expect(result.current.pause).toEqual(STOPPED)
    expect(result.current.queueHold).toBeUndefined()
    // Enter queues behind the held cards as usual; once nothing runs it asks again.
    expect(renderController(held).result.current.queueHold?.count).toBe(1)
  })

  it('Clear queue deletes every card shown, and answers true once all are gone', async () => {
    const { result, mutate } = renderController([card('held', 1), card('typed-after', 2)])
    let cleared: boolean | undefined
    await act(async () => {
      cleared = await result.current.queueHold?.clear()
    })
    expect(cleared).toBe(true)
    expect(mutate.mock.calls.map(([method, , fields]) => [method, fields.messageId])).toEqual([
      ['agentSession.queuedMessageDelete', 'held'],
      ['agentSession.queuedMessageDelete', 'typed-after']
    ])
  })

  it('a delete that fails makes Clear queue answer false', async () => {
    const { result } = renderController([card('held', 1), card('typed-after', 2)], {
      answer: (messageId) => (messageId === 'held' ? null : { deleted: true, messageId })
    })
    let cleared: boolean | undefined
    await act(async () => {
      cleared = await result.current.queueHold?.clear()
    })
    expect(cleared).toBe(false)
  })
})

describe('the confirmation copy', () => {
  it('counts the queued messages in the plural the language uses', () => {
    const confirm = (count: number) => ({
      open: true,
      count,
      clearQueue: vi.fn(),
      sendMessage: vi.fn(),
      dismiss: vi.fn()
    })
    const view = render(
      <NativeChatQueueSendConfirmDialog confirm={confirm(1)} focusComposer={vi.fn()} />
    )
    expect(screen.getByRole('dialog').textContent).toContain(
      'Do you want to clear the 1 message previously queued?'
    )
    view.rerender(<NativeChatQueueSendConfirmDialog confirm={confirm(3)} focusComposer={vi.fn()} />)
    expect(screen.getByRole('dialog').textContent).toContain(
      'Do you want to clear the 3 messages previously queued?'
    )
  })
})
