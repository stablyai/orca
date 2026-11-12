import type { ExplorerRepositorySourceState } from './file-explorer-repository-source'

/** Status and ignore chunks share admission; one stalled repository cannot replay another's completed work. */
export class ExplorerRepositoryReadQueue {
  private pending = new Map<
    ExplorerRepositorySourceState,
    { run: () => Promise<void>; finish: () => void; signal: AbortSignal }
  >()
  private active = 0
  private visible = false
  private disposed = false

  admit(
    key: ExplorerRepositorySourceState,
    signal: AbortSignal,
    run: () => Promise<void>
  ): Promise<void> {
    if (signal.aborted || !this.visible || this.disposed) {
      return Promise.resolve()
    }
    return new Promise((resolve, reject) => {
      const abort = (): void => {
        this.pending.delete(key)
        resolve()
      }
      signal.addEventListener('abort', abort, { once: true })
      const finish = (): void => {
        signal.removeEventListener('abort', abort)
        resolve()
      }
      this.pending.set(key, {
        signal,
        finish,
        run: async () => {
          try {
            await run()
          } catch (error) {
            reject(error)
          }
        }
      })
      this.drain()
    })
  }

  private drain(): void {
    while (this.visible && !this.disposed && this.active < 4 && this.pending.size > 0) {
      const next = this.pending.entries().next().value
      if (!next) {
        return
      }
      const [key, job] = next
      this.pending.delete(key)
      if (job.signal.aborted) {
        job.finish()
        continue
      }
      this.active++
      void job.run().finally(() => {
        this.active--
        job.finish()
        this.drain()
      })
    }
  }

  setVisible(visible: boolean): void {
    this.visible = visible
    this.drain()
  }

  dispose(): void {
    this.disposed = true
    for (const job of this.pending.values()) {
      job.finish()
    }
    this.pending.clear()
  }
}
