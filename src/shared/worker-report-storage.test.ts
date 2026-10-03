import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkerReportOutbox } from './worker-report-outbox'
import { drainWorkerReports } from './worker-report-recovery'
import {
  WORKER_REPORT_MAX_BYTES,
  WORKER_REPORT_MAX_RECORDS,
  WORKER_REPORT_RETRY_WINDOW_MS
} from './worker-report-record'

const roots: string[] = []
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'orca-report-security-'))
  roots.push(root)
  return { root, store: new WorkerReportOutbox(root) }
}
function input(requestId: string) {
  return {
    requestId,
    params: {
      from: 'term-worker',
      type: 'worker_done' as const,
      subject: 'Done',
      payload: JSON.stringify({ taskId: 'task-1', dispatchId: 'dispatch-1', outcome: 'succeeded' })
    },
    envelope: {
      orchestrationRequestId: requestId,
      orchestrationCapability: 'dcap-secret',
      orchestrationContractVersion: 1
    },
    pairing: null
  }
}
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
  vi.restoreAllMocks()
})

describe('worker report storage safety and retry bounds', () => {
  it('quarantines malformed records while delivering a valid sibling without logging credentials', async () => {
    const { store } = fixture()
    await store.enqueue(input('good'), 100)
    writeFileSync(join(store.directory, 'corrupt.json'), 'dcap-secret INVALID', { mode: 0o600 })
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const send = vi.fn(async () => ({
      id: 'rpc',
      ok: true as const,
      _meta: { runtimeId: 'runtime' },
      result: { lifecycle: { action: 'settled', outcome: 'succeeded' } }
    }))
    await drainWorkerReports(store, send, 100)
    expect(send).toHaveBeenCalledOnce()
    expect(readdirSync(store.directory)).toEqual(['corrupt.json.quarantined'])
    expect(log).toHaveBeenCalled()
    expect(JSON.stringify(log.mock.calls)).not.toContain('dcap-secret')
  })

  it('repairs pre-existing file and directory permissions before reading', async () => {
    const { store } = fixture()
    await store.enqueue(input('private'), 100)
    if (process.platform === 'win32') {
      return
    }
    const path = join(store.directory, readdirSync(store.directory)[0]!)
    chmodSync(store.directory, 0o755)
    chmodSync(path, 0o644)
    expect(await store.pending()).toHaveLength(1)
    expect(statSync(store.directory).mode & 0o777).toBe(0o700)
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  it('claims across concurrent instances without duplicate attempts', async () => {
    const { root, store } = fixture()
    await store.enqueue(input('concurrent'), 100)
    const claims = await Promise.all([
      store.claim('concurrent', 100),
      new WorkerReportOutbox(root).claim('concurrent', 100)
    ])
    expect(claims.filter(Boolean)).toHaveLength(1)
  })

  it('does not let backed-off old records starve ready reports', async () => {
    const { store } = fixture()
    for (let index = 0; index < 17; index++) {
      await store.enqueue(input(`request-${index}`), index)
      if (index < 16) {
        await store.claim(`request-${index}`, 100)
      }
    }
    const send = vi.fn(async () => ({
      id: 'rpc',
      ok: true as const,
      _meta: { runtimeId: 'runtime' },
      result: { lifecycle: { action: 'settled', outcome: 'succeeded' } }
    }))
    await drainWorkerReports(store, send, 100)
    expect(send).toHaveBeenCalledOnce()
    expect(send.mock.calls[0]).toEqual([expect.objectContaining({ requestId: 'request-16' })])
  })

  it('expires retries explicitly and removes capability material', async () => {
    const { store } = fixture()
    await store.enqueue(input('expired'), 0)
    const send = vi.fn()
    const rejected = vi.fn()
    await drainWorkerReports(store, send, WORKER_REPORT_RETRY_WINDOW_MS + 1, rejected)
    expect(send).not.toHaveBeenCalled()
    expect(rejected).toHaveBeenCalledWith('expired', 'report_retry_expired')
    const text = readFileSync(join(store.directory, readdirSync(store.directory)[0]!), 'utf8')
    expect(text).not.toContain('dcap-secret')
    expect(text).toContain('dispatch-1')
  })

  it('refuses oversize and full spools before sending or dropping existing work', async () => {
    const { store } = fixture()
    await expect(
      store.enqueue({
        ...input('large'),
        params: { ...input('large').params, body: 'a'.repeat(WORKER_REPORT_MAX_BYTES) }
      })
    ).rejects.toThrow('storage limit')
    for (let index = 0; index < WORKER_REPORT_MAX_RECORDS; index++) {
      writeFileSync(join(store.directory, `${index}.quarantined`), '')
    }
    await expect(store.enqueue(input('overflow'))).rejects.toThrow('full')
    expect(readdirSync(store.directory)).toHaveLength(WORKER_REPORT_MAX_RECORDS)
  })
})
