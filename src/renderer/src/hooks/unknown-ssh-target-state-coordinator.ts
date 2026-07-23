import type { SshConnectionState, SshTargetSummary } from '../../../shared/ssh-types'
import { admitSshConnectionState } from '../../../shared/ssh-retained-payload-admission'

export const UNKNOWN_SSH_TARGET_STATE_MAX_PENDING = 256

type UnknownSshTargetStateCoordinatorDependencies = {
  listTargets: () => Promise<SshTargetSummary[]>
  setTargetsMetadata: (targets: SshTargetSummary[]) => void
  applyState: (targetId: string, state: SshConnectionState) => void
  clearRemovedTargetState: (targetId: string) => void
}

export class UnknownSshTargetStateCoordinator {
  private readonly pending = new Map<string, { state: SshConnectionState; eventId: number }>()
  private refreshInFlight = false
  private disposed = false
  private nextEventId = 0

  constructor(
    private readonly dependencies: UnknownSshTargetStateCoordinatorDependencies,
    private readonly maxPending = UNKNOWN_SSH_TARGET_STATE_MAX_PENDING
  ) {}

  enqueue(targetId: string, value: unknown): boolean {
    const state = admitSshConnectionState(value, targetId)
    if (!state || this.disposed) {
      return false
    }
    const previous = this.pending.get(targetId)
    if (previous) {
      this.pending.delete(targetId)
    } else if (this.pending.size >= this.maxPending) {
      const oldestTargetId = this.pending.keys().next().value
      if (oldestTargetId !== undefined) {
        this.pending.delete(oldestTargetId)
      }
    }
    this.pending.set(targetId, {
      state,
      eventId: ++this.nextEventId
    })
    this.ensureRefresh()
    return true
  }

  forget(targetId: string): void {
    this.pending.delete(targetId)
  }

  dispose(): void {
    this.disposed = true
    this.pending.clear()
  }

  evidence(): { pending: number; refreshInFlight: boolean } {
    return { pending: this.pending.size, refreshInFlight: this.refreshInFlight }
  }

  private ensureRefresh(): void {
    if (this.refreshInFlight || this.disposed) {
      return
    }
    this.refreshInFlight = true
    const requestStartEventId = this.nextEventId
    void this.dependencies
      .listTargets()
      // Why: one retry preserves the prior transient-failure behavior without one request per event.
      .catch(() => this.dependencies.listTargets())
      .then(
        (targets) => this.finish(targets, requestStartEventId),
        () => this.finish(null, requestStartEventId)
      )
  }

  private finish(targets: SshTargetSummary[] | null, requestStartEventId: number): void {
    if (this.disposed) {
      return
    }
    this.refreshInFlight = false
    if (targets) {
      const targetIds = new Set(targets.map((target) => target.id))
      const applicable = Array.from(this.pending).filter(
        ([, entry]) => entry.eventId <= requestStartEventId
      )
      for (const [targetId] of applicable) {
        this.pending.delete(targetId)
      }
      if (applicable.length > 0) {
        this.dependencies.setTargetsMetadata(targets)
      }
      for (const [targetId, entry] of applicable) {
        if (targetIds.has(targetId)) {
          this.dependencies.applyState(targetId, entry.state)
        } else {
          this.dependencies.clearRemovedTargetState(targetId)
        }
      }
    } else {
      const applicable = Array.from(this.pending).filter(
        ([, entry]) => entry.eventId <= requestStartEventId
      )
      for (const [targetId] of applicable) {
        this.pending.delete(targetId)
      }
      for (const [targetId, entry] of applicable) {
        this.dependencies.applyState(targetId, entry.state)
      }
    }
    if (this.pending.size > 0) {
      this.ensureRefresh()
    }
  }
}
