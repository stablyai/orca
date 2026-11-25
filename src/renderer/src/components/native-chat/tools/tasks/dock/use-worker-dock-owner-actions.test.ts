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
const rpc = vi.hoisted(() => {
  const calls: Call[] = []
  return { calls }
})
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
function setup(identities?: Parameters<typeof useWorkerDockOwnerActions>[2]) {
  rpc.calls = []
  return renderHook(() => useWorkerDockOwnerActions({ kind: 'local' }, party, identities, () => {}))
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
  await settle(() =>
    last('orchestration.workerDockAcknowledge').reject(new Error('b restore failed'))
  )
  expect(hook.result.current.dialog?.error).toBe('b restore failed')
  act(() => hook.result.current.restore())
  await settle(() => last('orchestration.workerDockAcknowledge').resolve(undefined))
  expect(hook.result.current.dialog).toMatchObject({
    result: { acknowledged: false },
    error: null
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

it('never sends Stop for Clear on a failed row with no settlement', () => {
  const hook = setup()
  act(() => hook.result.current.action({ ...row('a'), settlement: null }, 'clear'))
  expect(rpc.calls).toEqual([])
  act(() => hook.result.current.action(row('b'), 'clear'))
  expect(rpc.calls.map((call) => [call.method, call.params.settlements])).toEqual([
    ['orchestration.workerDockAcknowledge', [{ dispatchId: 'b', settlement: 'settlement:b' }]]
  ])
})

it('clears all only the settled failures this owner can acknowledge', () => {
  const identity = (dispatchId: string, ownerActionsAvailable = true) => ({
    id: `home/source/worker/${dispatchId}`,
    dispatchId,
    state: 'failed' as const,
    changedAt: null,
    settlement: `settlement:${dispatchId}`,
    ownerActionsAvailable,
    hasModel: false
  })
  const hook = setup([
    identity('a'),
    identity('federated', false),
    { ...identity('unsettled'), settlement: null },
    identity('c')
  ])
  act(() => hook.result.current.clearAll())
  expect(last('orchestration.workerDockAcknowledge').params.settlements).toEqual([
    { dispatchId: 'a', settlement: 'settlement:a' },
    { dispatchId: 'c', settlement: 'settlement:c' }
  ])
  expect(hook.result.current.pending).toEqual(
    new Set(['home/source/worker/a', 'home/source/worker/c'])
  )
})

it('closes the card for good when the dock reads another host, so switching back cannot reopen it', async () => {
  rpc.calls = []
  type Target = Parameters<typeof useWorkerDockOwnerActions>[0]
  const hostA: Target = { kind: 'local' }
  const hostB: Target = { kind: 'environment', environmentId: 'env-b' }
  const initialProps: { target: Target } = { target: hostA }
  const hook = renderHook(
    ({ target }) => useWorkerDockOwnerActions(target, party, undefined, () => {}),
    { initialProps }
  )
  act(() => hook.result.current.open(row('a'), document.createElement('button')))
  const read = last('orchestration.workerDockResult')
  hook.rerender({ target: hostB })
  expect(hook.result.current.dialog).toBeNull()
  await settle(() => read.resolve(result('a')))
  hook.rerender({ target: hostA })
  expect(hook.result.current.dialog).toBeNull()
})
