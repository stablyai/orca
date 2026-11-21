import type { PtyFencedTerminationOutcome } from '../../../../../../shared/terminal/pty/lifecycle/pty-fenced-termination'

export type ResourcePtyEndError =
  | Extract<PtyFencedTerminationOutcome, { outcome: 'refused' }>['reason']
  | 'agent_running'

type EndingListener = (identities: readonly string[], ending: boolean) => void
export type ResourcePtyEndingSource = {
  getKeys: () => ReadonlySet<string>
  subscribe: (listener: EndingListener) => () => void
}

/** Publish individual status changes so a completion never copies the whole queue or error history. */
export class ResourcePtyActionStatus implements ResourcePtyEndingSource {
  private readonly ending = new Set<string>()
  private readonly errors = new Map<string, ResourcePtyEndError>()
  private readonly listeners = new Set<EndingListener>()
  private readonly rowListeners = new Map<string, Set<() => void>>()
  private lastRefusal: { count: number; reason: ResourcePtyEndError; sequence: number } | null =
    null
  getLastRefusal = () => this.lastRefusal
  getKeys = (): ReadonlySet<string> => this.ending
  isSelectable = (identity: string): boolean => !this.ending.has(identity)
  private selectionCheck = this.isSelectable
  getSelectionCheck = (): ((identity: string) => boolean) => this.selectionCheck

  getStatus(identity: string): 'ending' | ResourcePtyEndError | undefined {
    return this.ending.has(identity) ? 'ending' : this.errors.get(identity)
  }

  subscribe = (listener: EndingListener): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  subscribeSelection = (onChange: () => void): (() => void) =>
    this.subscribe((_identities, started) => {
      // Enqueue prunes selection. Completing a row only makes it selectable again.
      if (started) {
        onChange()
      }
    })

  subscribeRow(identity: string, listener: () => void): () => void {
    const listeners = this.rowListeners.get(identity) ?? new Set()
    listeners.add(listener)
    this.rowListeners.set(identity, listeners)
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) {
        this.rowListeners.delete(identity)
      }
    }
  }

  start(identities: readonly string[]): void {
    for (const identity of identities) {
      this.ending.add(identity)
      this.errors.delete(identity)
    }
    this.publish(identities, true)
  }

  complete(
    completions: readonly { identity: string; error?: ResourcePtyEndError }[],
    hasSession: (identity: string) => boolean
  ): void {
    let count = 0
    let reason: ResourcePtyEndError | undefined
    for (const { identity, error } of completions) {
      this.ending.delete(identity)
      if (error) {
        if (hasSession(identity)) {
          this.errors.set(identity, error)
        }
        count += 1
        reason = error
      }
    }
    if (reason) {
      this.lastRefusal = { count, reason, sequence: (this.lastRefusal?.sequence ?? 0) + 1 }
    }
    this.publish(
      completions.map(({ identity }) => identity),
      false
    )
  }

  retireError = (identity: string): void => {
    if (this.errors.delete(identity)) {
      this.publishRow(identity)
    }
  }

  private publish(identities: readonly string[], ending: boolean): void {
    if (ending) {
      this.selectionCheck = (identity) => this.isSelectable(identity)
    }
    for (const listener of this.listeners) {
      listener(identities, ending)
    }
    for (const identity of identities) {
      this.publishRow(identity)
    }
  }

  private publishRow(identity: string): void {
    this.rowListeners.get(identity)?.forEach((listener) => listener())
  }
}
