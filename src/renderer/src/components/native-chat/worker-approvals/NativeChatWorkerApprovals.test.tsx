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

it('says the Allow landed, and an answer to a prompt already closed is no failure', async () => {
  rpc.call.mockResolvedValueOnce({})
  render(<NativeChatWorkerApprovalStack approvals={[entry]} target={{ kind: 'local' }} />)
  fireEvent.click(screen.getByRole('button', { name: 'Allow' }))
  await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Allowed · try-claude'))

  rpc.call.mockRejectedValueOnce(
    new RuntimeRpcCallError({
      id: '1',
      ok: false,
      error: { code: 'approval_not_open', message: 'This prompt is no longer open' },
      _meta: { runtimeId: 'r' }
    })
  )
  fireEvent.click(screen.getByRole('button', { name: 'Allow' }))
  await waitFor(() =>
    expect(toast.info).toHaveBeenCalledWith('try-claude: this prompt had already closed')
  )
  expect(toast.error).not.toHaveBeenCalled()
})

it("closes the card at once when an answer finds the worker's Dispatch ended", async () => {
  const onClosed = vi.fn()
  rpc.call.mockRejectedValueOnce(
    new RuntimeRpcCallError({
      id: '1',
      ok: false,
      error: { code: 'dispatch_inactive', message: 'Dispatch ctx_1 is not running' },
      _meta: { runtimeId: 'r' }
    })
  )
  render(
    <NativeChatWorkerApprovalStack
      approvals={[entry]}
      target={{ kind: 'local' }}
      onClosed={onClosed}
    />
  )
  fireEvent.click(screen.getByRole('button', { name: 'Allow' }))
  await waitFor(() =>
    expect(onClosed).toHaveBeenCalledWith('apr_1', {
      by: 'worker-ended',
      decision: null,
      reason: null,
      reasonDelivered: false
    })
  )
  expect(toast.info).toHaveBeenCalledWith('try-claude has ended, so this prompt is closed')
  expect(toast.error).not.toHaveBeenCalled()
})
