import {
  isTerminalSetupStatus,
  type TerminalSetupStatus
} from '../../../../../shared/terminal/pty/lifecycle/terminal-setup-status'

type Observer = { resolve: () => void; reject: (error: unknown) => void }
type PendingSetup = {
  scope: string
  read: (signal: AbortSignal) => Promise<TerminalSetupStatus | null>
  observers: Set<Observer>
  expected?: TerminalSetupStatus
  abort?: AbortController
}

const refused = (): Error =>
  new Error(
    'The agent did not start because Setup could not be confirmed. Check the Setup terminal and try again.'
  )

/** One addressed listener per host; pending reads never retain a long-request slot. */
export class TerminalSetupObservers {
  private readonly scopes = new Map<string, Set<PendingSetup>>()
  private readonly byTarget = new Map<string, PendingSetup>()
  private readonly byPty = new Map<string, Set<PendingSetup>>()
  private readonly connected = new Set<string>()
  private readonly queue = new Set<PendingSetup>()
  private activeReads = 0
  onScopesChanged?: () => void

  pendingScopes(): string[] {
    return [...this.scopes.keys()].filter((scope) => scope !== 'local')
  }

  setConnected(scope: string, connected: boolean): void {
    if (connected === this.connected.has(scope)) {
      return
    }
    if (connected) {
      this.connected.add(scope)
    } else {
      this.connected.delete(scope)
    }
    for (const entry of this.scopes.get(scope) ?? []) {
      entry.abort?.abort()
      entry.abort = undefined
      if (connected) {
        this.read(entry)
      }
    }
  }

  changed(scope: string, status: TerminalSetupStatus): void {
    if (!this.connected.has(scope) || !isTerminalSetupStatus(status)) {
      return
    }
    for (const entry of this.byPty.get(this.key(scope, status.ptyId)) ?? []) {
      this.accept(entry, status)
    }
  }

  wait(
    scope: string,
    target: string,
    read: PendingSetup['read'],
    signal?: AbortSignal
  ): Promise<void> {
    if (signal?.aborted) {
      return Promise.reject(signal.reason)
    }
    const key = this.key(scope, target)
    let entry = this.byTarget.get(key)
    const fresh = !entry
    if (!entry) {
      entry = { scope, read, observers: new Set() }
      this.byTarget.set(key, entry)
      const entries = this.scopes.get(scope) ?? new Set()
      entries.add(entry)
      const added = !this.scopes.has(scope)
      this.scopes.set(scope, entries)
      if (added && scope !== 'local') {
        this.onScopesChanged?.()
      }
    }
    const pending = entry
    return new Promise<void>((resolve, reject) => {
      const observer = {
        resolve: () => {
          cleanup()
          resolve()
        },
        reject: (error: unknown) => {
          cleanup()
          reject(error)
        }
      }
      const onAbort = (): void => observer.reject(signal?.reason)
      const cleanup = (): void => {
        signal?.removeEventListener('abort', onAbort)
        pending.observers.delete(observer)
        if (pending.observers.size === 0) {
          this.remove(key, pending)
        }
      }
      pending.observers.add(observer)
      signal?.addEventListener('abort', onAbort, { once: true })
      if (fresh && this.connected.has(scope)) {
        this.read(pending)
      }
    })
  }

  private key(scope: string, id: string): string {
    return JSON.stringify([scope, id])
  }

  private remove(key: string, entry: PendingSetup): void {
    if (this.byTarget.get(key) !== entry) {
      return
    }
    this.byTarget.delete(key)
    this.queue.delete(entry)
    entry.abort?.abort()
    const entries = this.scopes.get(entry.scope)
    entries?.delete(entry)
    if (entries?.size === 0) {
      this.scopes.delete(entry.scope)
      if (entry.scope !== 'local') {
        this.onScopesChanged?.()
      }
    }
    if (entry.expected) {
      const ptyKey = this.key(entry.scope, entry.expected.ptyId)
      const owners = this.byPty.get(ptyKey)
      owners?.delete(entry)
      if (owners?.size === 0) {
        this.byPty.delete(ptyKey)
      }
    }
  }

  private settle(entry: PendingSetup, error?: unknown): void {
    for (const observer of entry.observers) {
      if (error) {
        observer.reject(error)
      } else {
        observer.resolve()
      }
    }
  }

  private accept(entry: PendingSetup, status: TerminalSetupStatus): void {
    const expected = entry.expected
    if (
      expected &&
      (expected.runtimeId !== status.runtimeId ||
        expected.ptyId !== status.ptyId ||
        expected.dependencyId !== status.dependencyId)
    ) {
      this.settle(entry, refused())
    } else if (status.state === 'ready') {
      this.settle(entry)
    } else if (status.state !== 'pending' || !status.dependencyId) {
      this.settle(entry, refused())
    }
  }

  private read(entry: PendingSetup): void {
    if (!entry.abort && entry.observers.size > 0) {
      this.queue.add(entry)
      this.drain()
    }
  }

  private drain(): void {
    while (this.activeReads < 8 && this.queue.size > 0) {
      const entry = this.queue.values().next().value!
      this.queue.delete(entry)
      if (this.connected.has(entry.scope)) {
        this.startRead(entry)
      }
    }
  }

  private startRead(entry: PendingSetup): void {
    if (entry.abort || entry.observers.size === 0) {
      return
    }
    this.activeReads += 1
    const abort = new AbortController()
    entry.abort = abort
    void entry
      .read(abort.signal)
      .then(
        (status) => {
          if (entry.abort !== abort || abort.signal.aborted) {
            return
          }
          entry.abort = undefined
          if (status === null) {
            // Only a proven unsupported host can use shipped readiness without this gate.
            this.settle(entry, entry.expected ? refused() : undefined)
            return
          }
          if (!isTerminalSetupStatus(status)) {
            this.settle(entry, refused())
            return
          }
          if (!entry.expected && status.state === 'pending') {
            entry.expected = status
            const key = this.key(entry.scope, status.ptyId)
            const entries = this.byPty.get(key) ?? new Set()
            entries.add(entry)
            this.byPty.set(key, entries)
            // Subscribe by exact PTY before rereading: completion during the first read cannot be lost.
            this.read(entry)
          } else {
            this.accept(entry, status)
          }
        },
        (error: unknown) => {
          if (entry.abort === abort && !abort.signal.aborted) {
            entry.abort = undefined
            this.settle(entry, error)
          }
        }
      )
      .finally(() => {
        this.activeReads -= 1
        this.drain()
      })
  }
}
