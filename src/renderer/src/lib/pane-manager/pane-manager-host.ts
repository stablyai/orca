import type {
  ManagedPaneInternal,
  PaneManagerOptions,
  PaneStyleOptions
} from './pane-manager-types'
import type { DragReorderCallbacks, DragReorderState } from './pane-drag-reorder'
import type { PaneIdentityRegistry } from './pane-identity-registry'

/** Accessor bundle the extracted PaneManager collaborators call back into.
 *  Why getters for activePaneId/styleOptions: both are reassigned during the
 *  manager's life, so capturing their values here would freeze stale state. */
export type PaneManagerHost = {
  panes: Map<number, ManagedPaneInternal>
  root: HTMLElement
  identities: PaneIdentityRegistry
  dragState: DragReorderState
  options: PaneManagerOptions
  getActivePaneId: () => number | null
  getStyleOptions: () => PaneStyleOptions
  isDestroyed: () => boolean
  isRenderingSuspended: () => boolean
  allocatePaneId: () => number
  createPaneInternal: (leafIdHint?: string) => ManagedPaneInternal
  createDivider: (isVertical: boolean) => HTMLElement
  publishPaneCreated: (
    pane: ManagedPaneInternal,
    spawnHints?: Parameters<NonNullable<PaneManagerOptions['onPaneCreated']>>[1]
  ) => void
  getDragCallbacks: () => DragReorderCallbacks
  setActivePane: (paneId: number, opts?: { focus?: boolean }) => void
  setActivePaneId: (paneId: number | null) => void
  requestPaneReparentFrame: (callback: FrameRequestCallback) => void
}
