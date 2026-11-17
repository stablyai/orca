import type { GitStatusEntry } from '../../../../../../shared/git/status/git-status-types'

export type SubmoduleReadHandlers = {
  /** Resolves null on failure so the caller keeps its last good result. */
  read: (submodulePath: string) => Promise<GitStatusEntry[] | null>
  apply: (submodulePath: string, entries: GitStatusEntry[]) => void
}

/** One concurrency budget across refreshes; a request for an in-flight path reads it again once it settles. */
export class SubmoduleStatusReadQueue {
  private active = 0
  private readonly pending = new Set<string>()
  private readonly inFlight = new Set<string>()
  private readonly rerun = new Set<string>()
  private wanted = new Set<string>()
  private handlers: SubmoduleReadHandlers | null = null

  constructor(private readonly concurrency: number) {}

  /** Replaces the wanted paths and handlers; queued work for paths no longer wanted is dropped. */
  setWanted(paths: readonly string[], handlers: SubmoduleReadHandlers | null): void {
    this.wanted = new Set(handlers ? paths : [])
    this.handlers = handlers
    for (const path of this.pending) {
      if (!this.wanted.has(path)) {
        this.pending.delete(path)
      }
    }
    for (const path of this.rerun) {
      if (!this.wanted.has(path)) {
        this.rerun.delete(path)
      }
    }
  }

  requestAll(): void {
    for (const path of this.wanted) {
      if (this.inFlight.has(path)) {
        this.rerun.add(path)
      } else {
        this.pending.add(path)
      }
    }
    this.pump()
  }

  private pump(): void {
    const handlers = this.handlers
    while (handlers && this.active < this.concurrency) {
      const next = this.pending.values().next()
      if (next.done) {
        return
      }
      this.pending.delete(next.value)
      this.start(next.value, handlers)
    }
  }

  private start(path: string, handlers: SubmoduleReadHandlers): void {
    this.active++
    this.inFlight.add(path)
    void handlers
      .read(path)
      .catch(() => null)
      .then((entries) => {
        if (entries) {
          handlers.apply(path, entries)
        }
      })
      // Bookkeeping must run even if apply throws, or the slot and path stay stuck.
      .finally(() => {
        this.active--
        this.inFlight.delete(path)
        if (this.rerun.delete(path) && this.wanted.has(path)) {
          this.pending.add(path)
        }
        this.pump()
      })
  }
}
