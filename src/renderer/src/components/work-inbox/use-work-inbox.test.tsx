// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useWorkInbox } from './use-work-inbox'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import type { WorkInboxItem } from '../../../../shared/work-inbox'
const list = vi.hoisted(() => vi.fn())
const answer = vi.hoisted(() => vi.fn())
vi.mock('./work-inbox-client', () => ({
  listWorkInbox: list,
  workInboxTargetKey: (host: RuntimeClientTarget) => JSON.stringify(host),
  answerWorkInboxItem: answer,
  changeWorkInboxStatus: vi.fn()
}))
const target: RuntimeClientTarget = { kind: 'local' }
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  list.mockReset()
  answer.mockReset()
})

const question: WorkInboxItem = {
  id: 'question',
  revision: 0,
  status: 'open',
  projectId: null,
  projectLabel: null,
  worktreeId: null,
  agentId: 'term_agent',
  agentLabel: 'Agent',
  agentKind: null,
  question: 'Continue?',
  options: [],
  allowFreeText: true,
  createdAt: 1
}
it.each(['ok', 'conflict', 'not-found', 'unreachable'])(
  'navigates only after a confirmed answer: %s',
  async (status) => {
    list.mockResolvedValue({ items: [question], openCount: 1 })
    const answered = { ...question, status: 'answered', revision: 1 }
    if (status === 'unreachable') {
      answer.mockRejectedValue(new Error('offline'))
      vi.spyOn(console, 'error').mockImplementation(() => {})
    } else {
      answer.mockResolvedValue({ status, item: answered })
    }
    const hook = renderHook(() => useWorkInbox({ open: true, target }))
    await act(async () => hook.result.current.updateDraft(question.id, { text: 'Continue' }))
    await act(async () => {
      expect(await hook.result.current.submitAnswer(question)).toEqual(
        status === 'ok' ? answered : undefined
      )
    })
  }
)
it.each(['closed', 'host-changed'])(
  'does not navigate when the view changed while sending: %s',
  async (change) => {
    list.mockResolvedValue({ items: [question], openCount: 1 })
    let complete: ((result: unknown) => void) | undefined
    answer.mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve
        })
    )
    const hook = renderHook<
      ReturnType<typeof useWorkInbox>,
      { open: boolean; target: RuntimeClientTarget }
    >((props) => useWorkInbox(props), {
      initialProps: { open: true, target }
    })
    await act(async () => hook.result.current.updateDraft(question.id, { text: 'Continue' }))
    let pending: Promise<WorkInboxItem | undefined> | undefined
    await act(async () => {
      pending = hook.result.current.submitAnswer(question)
    })
    await act(async () =>
      hook.rerender({
        open: change !== 'closed',
        target: change === 'host-changed' ? { kind: 'environment', environmentId: 'other' } : target
      })
    )
    await act(async () => {
      complete?.({ status: 'ok', item: { ...question, status: 'answered', revision: 1 } })
      expect(await pending).toBeUndefined()
    })
  }
)
it('polls only while open and refreshes when reopened', async () => {
  vi.useFakeTimers()
  list.mockResolvedValue({ items: [], openCount: 0 })
  const hook = renderHook(({ open }) => useWorkInbox({ open, target }), {
    initialProps: { open: false }
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60_000)
  })
  expect(list).not.toHaveBeenCalled()
  await act(async () => hook.rerender({ open: true }))
  expect(list).toHaveBeenCalledTimes(1)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(15_000)
  })
  expect(list).toHaveBeenCalledTimes(2)
  await act(async () => hook.rerender({ open: false }))
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60_000)
  })
  expect(list).toHaveBeenCalledTimes(2)
  await act(async () => hook.rerender({ open: true }))
  expect(list).toHaveBeenCalledTimes(3)
})
it('stops automatic retries for an unsupported host but permits explicit refresh', async () => {
  vi.useFakeTimers()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  list.mockRejectedValue({ code: 'method_not_found' })
  const hook = renderHook(() => useWorkInbox({ open: true, target }))
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60_000)
  })
  expect(list).toHaveBeenCalledTimes(1)
  expect(hook.result.current.loadError).toBe('unsupported')
  list.mockResolvedValue({ items: [], openCount: 0 })
  await act(async () => hook.result.current.reload())
  expect(hook.result.current.loadError).toBeNull()
})
