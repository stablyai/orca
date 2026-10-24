// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useStructuredAgentSessionQueuedReorder } from './use-structured-agent-session-queued-reorder'
import type { QueuedMessageCard } from './structured-agent-session-queued-cards'
import type { StructuredAgentSessionWrite } from './use-structured-agent-session-mutate'

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
afterEach(cleanup)

it('previews an ID-relative move in user slots, reverts refusal, and adopts host publication', async () => {
  const cards: QueuedMessageCard[] = ['a', 'mail', 'b', 'command'].map((messageId, position) => ({
    messageId,
    position,
    text: messageId,
    state: 'waiting',
    hold: 'queue-paused',
    ...(messageId === 'mail'
      ? { from: { kind: 'agent' as const, senders: [], orchestration: null } }
      : {}),
    ...(messageId === 'command' ? { command: true as const } : {})
  }))
  const answer = Promise.withResolvers<void>()
  let status: 'stale' | 'moved' = 'stale'
  const calls = vi.fn((..._args: unknown[]) => {})
  const write: StructuredAgentSessionWrite = async <T,>(
    ...args: Parameters<StructuredAgentSessionWrite>
  ) => {
    calls(...args)
    await answer.promise
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the test writer only answers queuedMessageMove.
    return { kind: 'done', value: { messageId: 'command', status } as T }
  }
  const hook = renderHook(
    ({ published }) =>
      useStructuredAgentSessionQueuedReorder(published, {
        target: { kind: 'local' },
        sessionId: 'session',
        capable: true,
        reorderCapable: true,
        write
      }),
    { initialProps: { published: cards } }
  )
  let moved: Promise<void> | undefined
  act(() => {
    moved = hook.result.current.reorder?.move('command', { beforeMessageId: 'a' })
  })
  expect(hook.result.current.cards.map((card) => card.messageId)).toEqual([
    'command',
    'mail',
    'a',
    'b'
  ])
  expect(calls).toHaveBeenCalledWith(
    'agentSession.queuedMessageMove',
    'agentSession.queuedMessageMove',
    { messageId: 'command', beforeMessageId: 'a' }
  )
  await act(async () => {
    answer.resolve()
    await moved
  })
  expect(hook.result.current.cards).toBe(cards)
  status = 'moved'
  await act(async () => {
    await hook.result.current.reorder?.move('command', { afterMessageId: 'a' })
  })
  expect(hook.result.current.cards.map((card) => card.messageId)).toEqual([
    'a',
    'mail',
    'command',
    'b'
  ])
  const published = [cards[3]!, cards[1]!, cards[2]!, cards[0]!]
  hook.rerender({ published })
  expect(hook.result.current.cards).toBe(published)
  expect(hook.result.current.reorder?.pending).toBe(false)
})
