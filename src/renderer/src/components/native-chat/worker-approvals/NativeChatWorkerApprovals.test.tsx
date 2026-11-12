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
  render(<NativeChatWorkerApprovalStack approvals={[entry]} target={{ kind: 'local' }} />)
}

it('waits on the host after a click: both buttons off, the clicked one working, no toast when it lands', async () => {
  renderStack()
  let land: (value: unknown) => void = () => {}
  rpc.call.mockReturnValueOnce(new Promise((resolve) => (land = resolve)))
  fireEvent.click(screen.getByRole('button', { name: 'Allow' }))
  expect(screen.getByRole('button', { name: 'Allow' })).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Deny' })).toBeDisabled()
  expect(
    screen.getByRole('button', { name: 'Allow' }).querySelector('.animate-spin')
  ).not.toBeNull()
  expect(screen.getByRole('button', { name: 'Deny' }).querySelector('.animate-spin')).toBeNull()
  land({})
  await waitFor(() => expect(screen.getByRole('button', { name: 'Allow' })).toBeEnabled())
  expect(toast.success).not.toHaveBeenCalled()
  expect(toast.info).not.toHaveBeenCalled()
})

it('leaves the card to the host list when the answer was not applied', async () => {
  renderStack()
  reject('approval_not_open')
  fireEvent.click(screen.getByRole('button', { name: 'Allow' }))
  await waitFor(() => expect(toast.info).toHaveBeenCalledTimes(1))
  // Still open as far as this card knows: answerable again until the host's list says otherwise.
  expect(screen.getByRole('button', { name: 'Allow' })).toBeEnabled()

  reject('internal_error')
  fireEvent.click(screen.getByRole('button', { name: 'Deny' }))
  await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1))
  expect(screen.getByRole('button', { name: 'Deny' })).toBeEnabled()
})
