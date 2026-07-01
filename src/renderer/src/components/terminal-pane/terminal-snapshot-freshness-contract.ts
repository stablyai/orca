import {
  reconcileDeadSessions,
  shouldReconcileDeadSession,
  type ReconcilableBinding
} from './terminal-dead-session-reconcile'

type TerminalSessionSnapshot = { id: string; cwd: string; title: string }

type PendingSnapshot = {
  resolve: (sessions: TerminalSessionSnapshot[]) => void
}

type PaneSurface = 'visible-active' | 'hidden-inactive'

export class TerminalSnapshotFreshnessContract {
  readonly provider = new DeferredTerminalSessionProvider()
  readonly visibleActivePane = new ContractPaneBinding('visible-active')
  readonly hiddenInactivePane = new ContractPaneBinding('hidden-inactive')

  requestSnapshot(): Promise<void> {
    return reconcileDeadSessions({
      bindings: [this.visibleActivePane, this.hiddenInactivePane],
      listSessions: () => this.provider.listSessions()
    })
  }
}

export class ContractPaneBinding implements ReconcilableBinding {
  readonly surface: PaneSurface
  readonly teardowns: string[] = []

  private ptyId: string | null = null
  private connectionId: string | null = null
  private ptyBoundAt: number | null = null

  constructor(surface: PaneSurface) {
    this.surface = surface
  }

  bindLocalPty(ptyId: string): void {
    this.ptyId = ptyId
    this.connectionId = null
    this.ptyBoundAt = performance.now()
  }

  bindSshPty(ptyId: string, connectionId: string): void {
    this.ptyId = ptyId
    this.connectionId = connectionId
    this.ptyBoundAt = performance.now()
  }

  reconcileIfSessionDead(liveSessionIds: Set<string>, snapshotRequestedAt?: number): void {
    if (
      !shouldReconcileDeadSession({
        ptyId: this.ptyId,
        connectionId: this.connectionId,
        liveSessionIds,
        ptyBoundAt: this.ptyBoundAt,
        snapshotRequestedAt
      })
    ) {
      return
    }
    this.teardowns.push(this.ptyId!)
  }
}

export class DeferredTerminalSessionProvider {
  requestCount = 0

  private pendingSnapshot: PendingSnapshot | null = null

  listSessions(): Promise<TerminalSessionSnapshot[]> {
    if (this.pendingSnapshot) {
      throw new Error('Only one pending liveness snapshot is supported by this contract harness')
    }
    this.requestCount += 1
    return new Promise<TerminalSessionSnapshot[]>((resolve) => {
      this.pendingSnapshot = { resolve }
    })
  }

  resolveSnapshot(sessionIds: string[]): void {
    if (!this.pendingSnapshot) {
      throw new Error('No pending liveness snapshot to resolve')
    }
    const pendingSnapshot = this.pendingSnapshot
    this.pendingSnapshot = null
    pendingSnapshot.resolve(
      sessionIds.map((id) => ({
        id,
        cwd: id,
        title: id
      }))
    )
  }
}
