import type { ManagedPaneInternal } from './pane-manager-types'
import { schedulePaneRevealPresent, schedulePaneRevealRepaint } from './pane-reveal-repaint'

export class PaneRevealFrameOwner {
  private cancelRepaint?: () => void
  private cancelPresent?: () => void

  constructor(
    private readonly owner: { isVisibleForAtlasRecovery: () => boolean },
    private readonly panes: ReadonlyMap<number, ManagedPaneInternal>
  ) {}

  scheduleRepaint(): void {
    this.cancelRepaint?.()
    if (this.owner.isVisibleForAtlasRecovery()) {
      this.cancelRepaint = schedulePaneRevealRepaint(() =>
        this.owner.isVisibleForAtlasRecovery() ? this.panes.values() : []
      )
    }
  }

  schedulePresent(): void {
    this.cancelPresent?.()
    if (this.owner.isVisibleForAtlasRecovery()) {
      this.cancelPresent = schedulePaneRevealPresent(() =>
        this.owner.isVisibleForAtlasRecovery() ? this.panes.values() : []
      )
    }
  }

  cancelPending(): void {
    this.cancelRepaint?.()
    this.cancelPresent?.()
    this.cancelRepaint = undefined
    this.cancelPresent = undefined
  }

  cancelIfHidden(visible: boolean): void {
    if (!visible) {
      this.cancelPending()
    }
  }
}
