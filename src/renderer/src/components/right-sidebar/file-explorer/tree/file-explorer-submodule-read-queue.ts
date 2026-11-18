import type { GitStatusEntry } from '../../../../../../shared/git/status/git-status-types'

export type SubmoduleReadHandlers = {
  /** Resolves null on failure so the caller keeps its last good result. */
  read: (submodulePath: string) => Promise<GitStatusEntry[] | null>
  apply: (submodulePath: string, entries: GitStatusEntry[]) => void
}

/** One concurrency budget across refreshes; keys by owner route + path so switches never alias. */
export class SubmoduleStatusReadQueue {
  private active = 0
  private readonly pending = new Set<string>()
  private readonly inFlight = new Set<string>()
  private readonly rerun = new Set<string>()
  private wanted = new Map<string, string>()
  private handlers: SubmoduleReadHandlers | null = null

  constructor(private readonly concurrency: number) {}

  /** Updates wanted route/paths; newly added keys enqueue immediately while dropped keys are pruned. */
  setWanted(
    scopeKey: string,
    paths: readonly string[],
    handlers: SubmoduleReadHandlers | null
  ): void {
    const prevWanted = this.wanted
    const nextWanted = new Map<string, string>()
    if (handlers) {
      for (const submodulePath of paths) {
        nextWanted.set(`${scopeKey}\0${submodulePath}`, submodulePath)
      }
    }
    this.wanted = nextWanted
    this.handlers = handlers
    for (const key of this.pending) {
      if (!nextWanted.has(key)) {
        this.pending.delete(key)
      }
    }
    for (const key of this.rerun) {
      if (!nextWanted.has(key)) {
        this.rerun.delete(key)
      }
    }
    for (const key of nextWanted.keys()) {
      if (!prevWanted.has(key)) {
        this.enqueue(key)
      }
    }
    this.pump()
  }

  requestAll(): void {
    for (const key of this.wanted.keys()) {
      this.enqueue(key)
    }
    this.pump()
  }

  private enqueue(key: string): void {
    if (this.inFlight.has(key)) {
      this.rerun.add(key)
    } else {
      this.pending.add(key)
    }
  }

  private pump(): void {
    const handlers = this.handlers
    while (handlers && this.active < this.concurrency) {
      const next = this.pending.values().next()
      if (next.done) {
        return
      }
      const key = next.value
      this.pending.delete(key)
      const submodulePath = this.wanted.get(key)
      if (submodulePath !== undefined) {
        this.start(key, submodulePath, handlers)
      }
    }
  }

  private start(key: string, submodulePath: string, handlers: SubmoduleReadHandlers): void {
    this.active++
    this.inFlight.add(key)
    void handlers
      .read(submodulePath)
      .catch(() => null)
      .then((entries) => {
        if (entries && this.wanted.has(key)) {
          handlers.apply(submodulePath, entries)
        }
      })
      // Bookkeeping must run even if apply throws, or the slot and key stay stuck.
      .finally(() => {
        this.active--
        this.inFlight.delete(key)
        if (this.rerun.delete(key) && this.wanted.has(key)) {
          this.pending.add(key)
        }
        this.pump()
      })
  }
}
