// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import type { WorkerDockRowView } from './WorkerDockRow'
import { useWorkerDockOwnerActions } from './use-worker-dock-owner-actions'

type Call = {
  method: string
  params: Record<string, unknown>
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
}
const rpc = vi.hoisted(() => ({ calls: [] as Call[] }))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({
  callRuntimeRpc: (_target: unknown, method: string, params: Record<string, unknown>) =>
    new Promise((resolve, reject) => rpc.calls.push({ method, params, resolve, reject }))
}))

const party = 'orca_session_id:11111111-1111-4111-8111-111111111111'
const row = (dispatchId: string): WorkerDockRowView => ({
  id: `home/source/worker/${dispatchId}`,
  dispatchId,
  source: 'source',
  kind: 'worker',
  name: dispatchId,
  title: dispatchId,
  model: null,
  state: 'failed',
  changedAt: null,
  startedAt: null,
  reason: null,
  settlement: `settlement:${dispatchId}`,
  resultId: null,
  stoppable: true,
  ownerActionsAvailable: true
})
const result = (dispatchId: string) => ({
  id: `report:${dispatchId}`,
  dispatchId,
  name: dispatchId,
  title: dispatchId,
  outcome: 'failed',
  body: `${dispatchId} failed`,
  at: null,
  settlement: `settlement:${dispatchId}`,
  acknowledged: true
})
const last = (method: string) => rpc.calls.findLast((call) => call.method === method)!
const settle = async (run: () => void) => {
  await act(async () => {
    run()
    await Promise.resolve()
  })
}
function setup() {
  rpc.calls = []
  return renderHook(() => useWorkerDockOwnerActions({ kind: 'local' }, party, undefined, () => {}))
}

it('applies a result read only to the dialog that opened it, and restores the shown dispatch', async () => {
  const hook = setup()
  const opener = document.createElement('button')
  act(() => hook.result.current.open(row('a'), opener))
  const readA = last('orchestration.workerDockResult')
  act(() => hook.result.current.close())
  act(() => hook.result.current.open(row('b'), opener))
  const readB = last('orchestration.workerDockResult')
  await settle(() => readA.resolve(result('a')))
  await settle(() => readA.reject(new Error('a unavailable')))
  expect(hook.result.current.dialog).toMatchObject({ result: null, error: null })
  await settle(() => readB.resolve(result('b')))
  expect(hook.result.current.dialog?.result?.dispatchId).toBe('b')
  act(() => hook.result.current.restore())
  expect(last('orchestration.workerDockAcknowledge').params).toMatchObject({
    settlements: [{ dispatchId: 'b', settlement: 'settlement:b' }],
    acknowledged: false
  })
})

it('offers Retry only for the failure it retries', async () => {
  const hook = setup()
  act(() => hook.result.current.action(row('a'), 'stop'))
  await settle(() => last('orchestration.workerDockStop').reject(new Error('a stop failed')))
  expect(hook.result.current.failure?.retry).toBeTypeOf('function')
  act(() => hook.result.current.dismissFailure())
  act(() => hook.result.current.open(row('b'), document.createElement('button')))
  await settle(() => last('orchestration.workerDockResult').resolve(result('b')))
  act(() => hook.result.current.restore())
  act(() => hook.result.current.close())
  await settle(() =>
    last('orchestration.workerDockAcknowledge').reject(new Error('b restore failed'))
  )
  expect(hook.result.current.failure).toEqual({ message: 'b restore failed' })
})
