// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { useStructuredAgentSessionQueuedReorder } from './use-structured-agent-session-queued-reorder'
import type { QueuedMessageCard } from '../../../../shared/structured-agent-session-queued-cards'
import {
  useStructuredAgentSessionMutate,
  type StructuredAgentSessionWrite
} from './use-structured-agent-session-mutate'
import { callStructuredAgentSession } from '@/runtime/structured-agent-session-client'

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: vi.fn()
}))
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

it('previews an ID-relative move across mixed senders with sending placeholders fixed, reverts refusal, and adopts host publication', async () => {
  const cards: QueuedMessageCard[] = ['a', 'mail', 'sending', 'b', 'command'].map(
    (messageId, position) => ({
      messageId,
      position,
      text: messageId,
      state: 'waiting',
      hold: messageId === 'sending' ? 'sending' : 'queue-paused',
      ...(messageId === 'mail'
        ? { from: { kind: 'agent' as const, senders: [], orchestration: null } }
        : {}),
      ...(messageId === 'command' ? { command: true as const } : {})
    })
  )
  const answer = Promise.withResolvers<void>()
  let status: 'stale' | 'moved' = 'stale'
  const calls = vi.fn((..._args: unknown[]) => {})
  const write: StructuredAgentSessionWrite = async <T,>(
    ...args: Parameters<StructuredAgentSessionWrite>
  ) => {
    calls(...args)
    await answer.promise
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the test writer only answers queuedMessageMove.
    return { kind: 'done', value: { messageId: args[2].messageId, status } as T }
  }
  const hook = renderHook(
    ({ published, capable }) =>
      useStructuredAgentSessionQueuedReorder(
        published,
        {
          target: { kind: 'local' },
          sessionId: 'session',
          capable: true,
          reorderCapable: capable,
          write
        },
        () => () => true
      ),
    { initialProps: { published: cards, capable: true } }
  )
  let moved: Promise<void> | undefined
  act(() => {
    moved = hook.result.current.reorder?.move('command', { beforeMessageId: 'mail' })
  })
  expect(hook.result.current.cards.map((card) => card.messageId)).toEqual([
    'a',
    'command',
    'sending',
    'mail',
    'b'
  ])
  expect(calls).toHaveBeenCalledWith(
    'agentSession.queuedMessageMove',
    'agentSession.queuedMessageMove',
    { messageId: 'command', beforeMessageId: 'mail' }
  )
  await act(async () => {
    answer.resolve()
    await moved
  })
  expect(hook.result.current.cards).toBe(cards)
  expect(toast.error).toHaveBeenCalledExactlyOnceWith(
    'The queue changed before this move. Try dragging the message again.'
  )
  status = 'moved'
  await act(async () => {
    await hook.result.current.reorder?.move('mail', { afterMessageId: 'b' })
  })
  expect(hook.result.current.cards.map((card) => card.messageId)).toEqual([
    'a',
    'b',
    'sending',
    'mail',
    'command'
  ])
  expect(hook.result.current.cards[3]).toBe(cards[1])
  await act(async () => {
    await hook.result.current.reorder?.move('sending', { beforeMessageId: 'mail' })
  })
  expect(calls).toHaveBeenCalledTimes(2)
  const published = [cards[4]!, cards[1]!, cards[2]!, cards[3]!, cards[0]!]
  hook.rerender({ published, capable: true })
  expect(hook.result.current.cards).toBe(published)
  expect(hook.result.current.reorder?.pending).toBe(false)
  hook.rerender({ published, capable: false })
  expect(hook.result.current.reorder).toBeUndefined()
  expect(calls).toHaveBeenCalledTimes(2)
})

it.each(['stale', 'not-done'] as const)(
  'settles an admitted %s move without feedback after the issuing visit ends',
  async (outcome) => {
    const cards: QueuedMessageCard[] = ['a', 'b'].map((messageId, position) => ({
      messageId,
      position,
      text: messageId,
      state: 'waiting',
      hold: 'queue-paused'
    }))
    for (const departure of ['unmount', 'switch-away-and-back'] as const) {
      const answer = Promise.withResolvers<unknown>()
      vi.mocked(callStructuredAgentSession).mockReturnValueOnce(answer.promise)
      const hook = renderHook(
        ({ sessionId }) => {
          const transport = { target: { kind: 'local' as const }, sessionId }
          const mutation = useStructuredAgentSessionMutate({
            ...transport,
            stateRef: { current: { fence: 3 } }
          })
          return useStructuredAgentSessionQueuedReorder(
            cards,
            { ...transport, capable: true, reorderCapable: true, write: mutation.write },
            mutation.capturePresentation
          )
        },
        { initialProps: { sessionId: 'session-a' } }
      )
      let moved: Promise<void> | undefined
      act(() => {
        moved = hook.result.current.reorder?.move('a', { afterMessageId: 'b' })
      })
      expect(callStructuredAgentSession).toHaveBeenLastCalledWith(
        { kind: 'local' },
        'agentSession.queuedMessageMove',
        expect.objectContaining({
          envelope: expect.objectContaining({ sessionId: 'session-a' }),
          messageId: 'a',
          afterMessageId: 'b'
        })
      )
      if (departure === 'unmount') {
        hook.unmount()
      } else {
        hook.rerender({ sessionId: 'session-b' })
        hook.rerender({ sessionId: 'session-a' })
      }
      await act(async () => {
        answer.resolve(
          outcome === 'stale'
            ? { ok: true, value: { messageId: 'a', status: 'stale' } }
            : { ok: false, refusal: { code: 'agent_session_conflict', message: 'Changed.' } }
        )
        await moved
      })
      expect(toast.error).not.toHaveBeenCalled()
      if (departure !== 'unmount') {
        expect(hook.result.current.cards).toBe(cards)
        expect(hook.result.current.reorder?.pending).toBe(false)
        hook.unmount()
      }
    }
    expect(callStructuredAgentSession).toHaveBeenCalledTimes(2)
  }
)
