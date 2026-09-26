import type { RuntimeRpcResponse } from './runtime-rpc-envelope'
import type { WorkerReportInput } from './worker-report-record'
import { WorkerReportOutbox } from './worker-report-outbox'
import { drainWorkerReports } from './worker-report-recovery'

export class WorkerReportRecoveryService {
  private timer: ReturnType<typeof setTimeout> | null = null
  private active: Promise<void> | null = null
  private stopped = false
  private readonly store: WorkerReportOutbox

  constructor(
    userDataPath: string,
    private readonly send: (input: WorkerReportInput) => Promise<RuntimeRpcResponse<unknown>>
  ) {
    this.store = new WorkerReportOutbox(userDataPath)
  }

  start(): void {
    this.stopped = false
    void this.drain()
  }

  drain(): Promise<void> {
    if (this.active) {
      return this.active
    }
    if (this.stopped) {
      return Promise.resolve()
    }
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.active = drainWorkerReports(
      this.store,
      this.send,
      Date.now(),
      (requestId, code) => {
        console.error(`[orchestration] Worker report ${requestId} rejected: ${code}`)
      },
      () => !this.stopped
    )
      .then(() => undefined)
      .catch((error: unknown) => {
        // Never log the record or transport error: both may contain Dispatch credentials.
        console.error(
          '[orchestration] Worker report outbox recovery failed; durable records retained.',
          error instanceof Error &&
            'code' in error &&
            typeof error.code === 'string' &&
            /^[a-z_]{1,80}$/i.test(error.code)
            ? error.code
            : 'storage_error'
        )
      })
      .finally(() => {
        this.active = null
        if (!this.stopped) {
          this.timer = setTimeout(() => {
            this.timer = null
            void this.drain()
          }, 5_000)
          this.timer.unref?.()
        }
      })
    return this.active
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer) {
      clearTimeout(this.timer)
    }
    this.timer = null
    const active = this.active
    if (!active) {
      return
    }
    let deadline: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        active,
        new Promise<void>((resolve) => {
          deadline = setTimeout(resolve, 2_000)
          deadline.unref?.()
        })
      ])
    } finally {
      if (deadline) {
        clearTimeout(deadline)
      }
    }
  }
}
