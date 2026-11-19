// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { OrchestrationWorkerApprovalsFrame } from '../../../../../shared/orchestration/orchestration-crew'
import {
  useNativeChatPinnedWorkerApprovals,
  useNativeChatWorkerApprovalReceipts,
  type NativeChatWorkerApproval
} from './native-chat-worker-approval-feed'

const stream = vi.hoisted(() => ({ emit: (_frame: unknown): void => {} }))
vi.mock('@/runtime/rpc/subscriptions/runtime-rpc-subscribe', () => ({
  subscribeRuntimeRpc: (
    _target: unknown,
    _method: string,
    _params: unknown,
    handlers: { onEvent: (value: unknown) => void }
  ) => {
    stream.emit = handlers.onEvent
    return Promise.resolve({ unsubscribe: () => {} })
  }
}))

const entry = (state: 'open' | 'answered'): NativeChatWorkerApproval => ({
  approval: {
    v: 1,
    approvalId: 'apr_bash',
    state,
    worker: { handle: 'term_worker', dispatchId: 'ctx_1', taskId: 'task_1' },
    summary: { title: 'Allow Bash?', detail: 'ls', reason: null },
    allowedActions: state === 'open' ? ['allow', 'deny'] : [],
    ...(state === 'answered'
      ? {
          outcome: { by: 'person', decision: 'allow', reason: null, reasonDelivered: false }
        }
      : {})
  },
  at: '2026-11-18T21:00:00.000Z',
  worker: {
    partyKey: 'w',
    role: 'worker',
    label: 'w',
    agentKind: 'claude',
    status: 'blocked',
    openTarget: { kind: 'terminal', handle: 'term_worker' }
  }
})

const sendList = (entries: NativeChatWorkerApproval[]): void =>
  act(() => {
    const frames: OrchestrationWorkerApprovalsFrame[] = [
      { type: 'begin' },
      ...entries.map((e) => ({ type: 'approval' as const, entry: e })),
      { type: 'complete' }
    ]
    frames.forEach((frame) => stream.emit(frame))
  })

describe('worker approval feed', () => {
  it('moves an answered prompt into the transcript at once, not after a pause above the composer', () => {
    const party = 'orca_session_id:coordinator'
    const view = renderHook(() => ({
      pinned: useNativeChatPinnedWorkerApprovals(party),
      receipts: useNativeChatWorkerApprovalReceipts(party)
    }))
    sendList([entry('open')])
    expect(view.result.current.pinned.map((e) => e.approval.state)).toEqual(['open'])
    expect(view.result.current.receipts).toEqual([])

    sendList([entry('answered')])
    expect(view.result.current.pinned).toEqual([])
    expect(view.result.current.receipts.map((e) => e.approval.approvalId)).toEqual(['apr_bash'])
    view.unmount()
  })
})
