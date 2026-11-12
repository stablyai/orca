// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { useStructuredAgentSessionQueuedReorder } from './use-structured-agent-session-queued-reorder'
import type { QueuedMessageCard } from '../../../../../shared/agent-session/view/structured-agent-session-queued-cards'
import { useStructuredAgentSessionMutate } from '../session/structured/writes/use-structured-agent-session-mutate'
import { callStructuredAgentSession } from '@/runtime/native-chat/requests/structured-agent-session-call'

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('../../../runtime/native-chat/requests/structured-agent-session-call', () => ({
  callStructuredAgentSession: vi.fn()
}))
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
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
