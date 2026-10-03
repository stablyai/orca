import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkerReportRecoveryService } from './worker-report-recovery-service'
import { drainWorkerReports } from './worker-report-recovery'

vi.mock('./worker-report-recovery', () => ({ drainWorkerReports: vi.fn() }))
afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('worker report recovery shutdown', () => {
  it('returns immediately when idle', async () => {
    vi.useFakeTimers()
    const service = new WorkerReportRecoveryService('/unused', vi.fn())
    await service.stop()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('bounds an in-flight wait and never schedules another drain after stopping', async () => {
    vi.useFakeTimers()
    let finish: (value: { pending: number }) => void = () => {}
    vi.mocked(drainWorkerReports).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const service = new WorkerReportRecoveryService('/unused', vi.fn())
    service.start()
    const stopped = vi.fn()
    const stopping = service.stop().then(stopped)
    await vi.advanceTimersByTimeAsync(1_999)
    expect(stopped).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await stopping
    expect(stopped).toHaveBeenCalledOnce()
    finish({ pending: 1 })
    await service.drain()
    expect(vi.getTimerCount()).toBe(0)
    expect(drainWorkerReports).toHaveBeenCalledOnce()
  })
})
