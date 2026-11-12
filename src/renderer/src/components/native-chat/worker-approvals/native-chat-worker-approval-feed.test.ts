// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { OrchestrationWorkerApprovalEntry } from '../../../../../shared/orchestration/orchestration-crew'

const stream = vi.hoisted(() => ({ emit: (_frame: unknown): void => {} }))
vi.mock('@/runtime/rpc/subscriptions/runtime-rpc-subscribe', () => ({
  subscribeRuntimeRpc: (
    _target: unknown,
    _method: string,
    _params: unknown,
    handlers: { onEvent: (frame: unknown) => void }
  ) => {
    stream.emit = handlers.onEvent
    return Promise.resolve({ unsubscribe: () => {} })
  }
}))

const feed = await import('./native-chat-worker-approval-feed')

afterEach(() => {
  vi.useRealTimers()
})

const PARTY = 'orca_session_id:chat'
function approval(
  approvalId: string,
  state: 'open' | 'answered',
  by?: 'person' | 'terminal-only'
): OrchestrationWorkerApprovalEntry {
  return {
    approval: {
      v: 1,
      approvalId,
      state,
      worker: { handle: 'term_w', dispatchId: 'ctx_1', taskId: 'task_1' },
      summary: { title: 'Allow Bash?', detail: null, reason: null },
      allowedActions: state === 'open' ? ['allow', 'deny'] : [],
      ...(by
        ? {
            outcome: {
              by,
              decision: by === 'person' ? 'allow' : null,
              reason: null,
              reasonDelivered: false
            }
          }
        : {})
    },
    at: '2026-11-11T20:00:00.000Z',
    worker: { partyKey: 'w', role: 'worker', label: 'w', agentKind: 'claude', status: 'blocked' }
  }
}
function send(...entries: OrchestrationWorkerApprovalEntry[]): void {
  act(() => {
    stream.emit({ type: 'begin' })
    for (const entry of entries) {
      stream.emit({ type: 'approval', entry })
    }
    stream.emit({ type: 'complete' })
  })
}

it('keeps a prompt that closed while shown pinned as its receipt for a moment, then moves it to the transcript', async () => {
  vi.useFakeTimers()
  const pinned = renderHook(() => feed.useNativeChatPinnedWorkerApprovals(PARTY))
  const receipts = renderHook(() => feed.useNativeChatWorkerApprovalReceipts(PARTY))
  await act(async () => {})
  send(approval('apr_old', 'answered', 'person'), approval('apr_1', 'open'))
  expect(pinned.result.current.map((e) => e.approval.approvalId)).toEqual(['apr_1'])
  const history = receipts.result.current

  // The host closes it: its receipt stays where the card was for a moment.
  send(approval('apr_old', 'answered', 'person'), approval('apr_1', 'answered', 'person'))
  expect(pinned.result.current.map((e) => [e.approval.approvalId, e.approval.state])).toEqual([
    ['apr_1', 'answered']
  ])
  // Only a pinned prompt changed: the transcript's receipts are the same array.
  expect(receipts.result.current).toBe(history)
  act(() => vi.advanceTimersByTime(4_000))
  expect(pinned.result.current).toEqual([])
  expect(receipts.result.current.map((e) => e.approval.approvalId)).toEqual(['apr_old', 'apr_1'])
})
