import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkerReportOutbox } from './worker-report-outbox'
import { drainWorkerReports } from './worker-report-recovery'
import type { WorkerReportInput } from './worker-report-record'

const roots: string[] = []
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'orca-report-test-'))
  roots.push(root)
  return { root, store: new WorkerReportOutbox(root) }
}
const input = {
  requestId: 'request-1',
  params: {
    from: 'term-worker',
    type: 'worker_done' as const,
    subject: 'Finished',
    body: 'Done.',
    payload: JSON.stringify({ taskId: 'task-1', dispatchId: 'dispatch-1', outcome: 'succeeded' }),
    waitForLifecycleSettlement: true
  },
  envelope: {
    orchestrationCapability: 'dcap-secret',
    orchestrationRequestId: 'request-1',
    orchestrationContractVersion: 1
  },
  pairing: null
}
const accepted = {
  ok: true as const,
  id: 'rpc-1',
  _meta: { runtimeId: 'runtime-1' },
  result: { lifecycle: { action: 'settled', outcome: 'succeeded' } }
}
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('durable worker report custody', () => {
  it('does not send when shutdown interrupts a durable claim', async () => {
    const { store } = fixture()
    await store.enqueue(input, 100)
    let running = true
    const claim = store.claim.bind(store)
    vi.spyOn(store, 'claim').mockImplementation(async (...args) => {
      const record = await claim(...args)
      running = false
      return record
    })
    const send = vi.fn(async () => accepted)
    await drainWorkerReports(
      store,
      send,
      100,
      () => {},
      () => running
    )
    expect(send).not.toHaveBeenCalled()
    expect(await store.pending()).toHaveLength(1)
    await drainWorkerReports(store, send, 100_000)
    expect(send).toHaveBeenCalledOnce()
    expect(await store.pending()).toEqual([])
  })

  it('keeps custody if shutdown begins while a report is in flight', async () => {
    const { store } = fixture()
    await store.enqueue(input, 100)
    let running = true
    await drainWorkerReports(
      store,
      async () => {
        running = false
        return accepted
      },
      100,
      () => {},
      () => running
    )
    expect(await store.pending()).toHaveLength(1)
    await drainWorkerReports(store, async () => accepted, 100_000)
    expect(await store.pending()).toEqual([])
  })

  it('persists before send and recovers after both caller and runtime restart', async () => {
    const { root, store } = fixture()
    await store.enqueue(input, 100)
    const first = await drainWorkerReports(
      store,
      async () => {
        throw new Error('disconnected')
      },
      100
    )
    expect(first.pending).toBe(1)
    const restarted = new WorkerReportOutbox(root)
    const received: unknown[] = []
    await drainWorkerReports(
      restarted,
      async (record) => {
        received.push(record)
        return accepted
      },
      100_000
    )
    expect(received).toEqual([expect.objectContaining(input)])
    expect(await restarted.pending()).toEqual([])
  })

  it('replays the original identity when durable acceptance loses its response', async () => {
    const { root, store } = fixture()
    await store.enqueue(input, 100)
    const receipts = new Set<string>()
    let effects = 0
    const send = async (record: WorkerReportInput) => {
      if (!receipts.has(record.requestId)) {
        receipts.add(record.requestId)
        effects++
        throw new Error('lost response')
      }
      return accepted
    }
    await drainWorkerReports(store, send, 100)
    await drainWorkerReports(new WorkerReportOutbox(root), send, 100_000)
    expect(effects).toBe(1)
    expect(await store.pending()).toEqual([])
  })

  it('retains custody for an unverified success and records explicit rejection without secrets', async () => {
    const { root, store } = fixture()
    await store.enqueue(input, 100)
    await drainWorkerReports(
      store,
      async () => ({ ...accepted, result: { message: { id: 'unverified' } } }),
      100
    )
    expect(await store.pending()).toHaveLength(1)
    await drainWorkerReports(
      store,
      async () => ({
        ...accepted,
        result: { lifecycle: { action: 'rejected', code: 'stale_dispatch', reason: 'stale' } }
      }),
      100_000
    )
    expect(await store.pending()).toEqual([])
    const record = readdirSync(join(root, 'worker-report-outbox')).find((name) =>
      name.endsWith('.json')
    )
    const text = readFileSync(join(root, 'worker-report-outbox', record!), 'utf8')
    expect(text).toContain('stale_dispatch')
    expect(text).not.toContain('dcap-secret')
  })

  it('refuses a changed payload under one operation and keeps private permissions', async () => {
    const { root, store } = fixture()
    await store.enqueue(input, 100)
    await expect(
      store.enqueue({ ...input, params: { ...input.params, body: 'Different' } }, 100)
    ).rejects.toThrow('different')
    if (process.platform !== 'win32') {
      expect(statSync(join(root, 'worker-report-outbox')).mode & 0o777).toBe(0o700)
    }
  })

  it('refuses a symlinked spool directory', async () => {
    const { root, store } = fixture()
    const other = fixture().root
    symlinkSync(
      other,
      join(root, 'worker-report-outbox'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    await expect(store.enqueue(input, 100)).rejects.toThrow('symlink')
  })
})
