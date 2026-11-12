// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { OrchestrationCrewRow } from '../../../../../shared/orchestration/orchestration-crew'

const rpc = vi.hoisted(() => ({ call: vi.fn() }))
const toast = vi.hoisted(() => ({ success: vi.fn(), info: vi.fn(), error: vi.fn() }))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({ callRuntimeRpc: rpc.call }))
vi.mock('sonner', () => ({ toast }))

const { RuntimeRpcCallError } = await import('@/runtime/rpc/calls/runtime-rpc-result')
const { NativeChatWorkerApprovalStack } = await import('./NativeChatWorkerApprovals')

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const worker: OrchestrationCrewRow = {
  partyKey: 'w',
  role: 'worker',
  label: 'try-claude',
  agentKind: 'claude',
  status: 'blocked'
}
const entry = {
  approval: {
    v: 1 as const,
    approvalId: 'apr_1',
    state: 'open' as const,
    worker: { handle: 'term_w', dispatchId: 'ctx_1', taskId: 'task_1' },
    summary: { title: 'Allow Bash?', detail: 'rg -n x', reason: null },
    allowedActions: ['allow' as const, 'deny' as const]
  },
  at: '2026-11-11T20:11:30.000Z',
  askedAt: '2026-11-11T20:11:24.000Z',
  worker
}

const reject = (code: string) =>
  rpc.call.mockRejectedValueOnce(
    new RuntimeRpcCallError({
      id: '1',
      ok: false,
      error: { code, message: code },
      _meta: { runtimeId: 'r' }
    })
  )

function renderStack() {
  const onClosed = vi.fn()
  render(
    <NativeChatWorkerApprovalStack
      approvals={[entry]}
      target={{ kind: 'local' }}
      onClosed={onClosed}
    />
  )
  return onClosed
}

it('answers the card on click, before the host confirms, with no toast once it lands', async () => {
  const onClosed = renderStack()
  let land: (value: unknown) => void = () => {}
  rpc.call.mockReturnValueOnce(new Promise((resolve) => (land = resolve)))
  fireEvent.click(screen.getByRole('button', { name: 'Allow' }))
  // The RPC has not resolved: the card is already shown as allowed by the person.
  expect(onClosed).toHaveBeenCalledWith('apr_1', {
    by: 'person',
    decision: 'allow',
    reason: null,
    reasonDelivered: false
  })
  land({})
  await waitFor(() => expect(screen.getByRole('button', { name: 'Allow' })).toBeEnabled())
  expect(onClosed).toHaveBeenCalledTimes(1)
  expect(toast.success).not.toHaveBeenCalled()
  expect(toast.info).not.toHaveBeenCalled()
})

it('hands the card back to the host list when the answer did not reach the prompt', async () => {
  const onClosed = renderStack()
  reject('approval_not_open')
  fireEvent.click(screen.getByRole('button', { name: 'Allow' }))
  // A prompt the host still holds open must stay answerable: no local close outlives the click.
  await waitFor(() => expect(onClosed).toHaveBeenLastCalledWith('apr_1', null))
  expect(toast.info).toHaveBeenCalledTimes(1)

  reject('internal_error')
  fireEvent.click(screen.getByRole('button', { name: 'Allow' }))
  await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1))
  expect(onClosed).toHaveBeenLastCalledWith('apr_1', null)
})

it("closes the card at once when an answer finds the worker's Dispatch ended", async () => {
  const onClosed = renderStack()
  reject('dispatch_inactive')
  fireEvent.click(screen.getByRole('button', { name: 'Allow' }))
  await waitFor(() =>
    expect(onClosed).toHaveBeenLastCalledWith('apr_1', {
      by: 'worker-ended',
      decision: null,
      reason: null,
      reasonDelivered: false
    })
  )
  expect(toast.error).not.toHaveBeenCalled()
})
