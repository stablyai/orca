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
const last = (method: string) => rpc.calls.findLast((call) => call.method === method)!
function setup(identities?: Parameters<typeof useWorkerDockOwnerActions>[2]) {
  rpc.calls = []
  return renderHook(() => useWorkerDockOwnerActions({ kind: 'local' }, party, identities))
}

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
