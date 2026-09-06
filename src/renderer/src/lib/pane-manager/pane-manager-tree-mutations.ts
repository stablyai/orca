import type { ManagedPane, PaneSplitOptions } from './pane-manager-types'
import type { PaneManagerHost } from './pane-manager-host'
import type { SplitPaneAroundLeafIdsOptions } from './pane-subtree-split'
import {
  closeManagedPane,
  detachManagedPaneForExternalMove,
  retireManagedPanePreservingPty,
  splitManagedPane
} from './pane-split-close'
import { splitPaneAroundMountedSubtree } from './pane-subtree-split'

export function splitPaneOnManager(
  host: PaneManagerHost,
  paneId: number,
  direction: 'vertical' | 'horizontal',
  opts?: PaneSplitOptions
): ManagedPane | null {
  return splitManagedPane({
    paneId,
    direction,
    opts,
    panes: host.panes,
    root: host.root,
    styleOptions: host.getStyleOptions(),
    managerOptions: host.options,
    createPaneInternal: (leafIdHint) => host.createPaneInternal(leafIdHint),
    createDivider: (isVertical) => host.createDivider(isVertical),
    publishPaneCreated: (pane, spawnHints) => host.publishPaneCreated(pane, spawnHints),
    getDragCallbacks: () => host.getDragCallbacks(),
    setActivePaneId: (id) => {
      host.setActivePaneId(id)
    },
    isDestroyed: () => host.isDestroyed()
  })
}

export function splitPaneAroundLeafIdsOnManager(
  host: PaneManagerHost,
  sourceLeafIds: readonly string[],
  fallbackPaneId: number,
  direction: 'vertical' | 'horizontal',
  opts?: SplitPaneAroundLeafIdsOptions
): ManagedPane | null {
  return splitPaneAroundMountedSubtree({
    sourceLeafIds,
    fallbackPaneId,
    direction,
    opts,
    panes: host.panes,
    root: host.root,
    styleOptions: host.getStyleOptions(),
    managerOptions: host.options,
    getNumericIdForLeaf: (leafId) => host.identities.getNumericIdForLeaf(leafId),
    createPaneInternal: (leafIdHint) => host.createPaneInternal(leafIdHint),
    createDivider: (isVertical) => host.createDivider(isVertical),
    publishPaneCreated: (pane, spawnHints) => host.publishPaneCreated(pane, spawnHints),
    getDragCallbacks: () => host.getDragCallbacks(),
    setActivePaneId: (id) => {
      host.setActivePaneId(id)
    },
    isDestroyed: () => host.isDestroyed()
  })
}

export function closePaneOnManager(host: PaneManagerHost, paneId: number): void {
  closeManagedPane({
    paneId,
    activePaneId: host.getActivePaneId(),
    panes: host.panes,
    root: host.root,
    styleOptions: host.getStyleOptions(),
    managerOptions: host.options,
    getDragCallbacks: () => host.getDragCallbacks(),
    releasePaneIdentity: (numericPaneId) => host.identities.release(numericPaneId),
    setActivePaneId: (id) => {
      host.setActivePaneId(id)
    }
  })
}

export function detachPaneForExternalMoveOnManager(host: PaneManagerHost, paneId: number): boolean {
  return detachManagedPaneForExternalMove({
    paneId,
    activePaneId: host.getActivePaneId(),
    panes: host.panes,
    root: host.root,
    styleOptions: host.getStyleOptions(),
    managerOptions: host.options,
    getDragCallbacks: () => host.getDragCallbacks(),
    releasePaneIdentity: (numericPaneId) => host.identities.release(numericPaneId),
    setActivePaneId: (id) => {
      host.setActivePaneId(id)
    }
  })
}

export function retirePanePreservingPtyOnManager(host: PaneManagerHost, paneId: number): boolean {
  return retireManagedPanePreservingPty({
    paneId,
    activePaneId: host.getActivePaneId(),
    panes: host.panes,
    root: host.root,
    styleOptions: host.getStyleOptions(),
    managerOptions: host.options,
    getDragCallbacks: () => host.getDragCallbacks(),
    releasePaneIdentity: (numericPaneId) => host.identities.release(numericPaneId),
    setActivePaneId: (id) => {
      host.setActivePaneId(id)
    }
  })
}
