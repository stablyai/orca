import type {
  ManagedPaneInternal,
  PaneManagerOptions,
  PaneStyleOptions
} from './pane-manager-types'
import type { DragReorderCallbacks } from './pane-drag-reorder'
import { updateMultiPaneState } from './pane-drag-reorder'
import { applyPaneOpacity } from './pane-divider'
import { findPaneChildren, promoteSibling, removeDividers, safeFit } from './pane-tree-ops'
import {
  disposePane,
  runPaneCleanupLedger,
  runPaneCleanupStep,
  throwPaneCleanupErrors
} from './pane-lifecycle'

export type CloseManagedPaneArgs = {
  paneId: number
  activePaneId: number | null
  panes: Map<number, ManagedPaneInternal>
  root: HTMLElement
  styleOptions: PaneStyleOptions
  managerOptions: PaneManagerOptions
  getDragCallbacks: () => DragReorderCallbacks
  releasePaneIdentity: (numericPaneId: number) => void
  setActivePaneId: (paneId: number | null) => void
}

type ManagedPaneTeardown = {
  pane: ManagedPaneInternal
  reason: 'close' | 'detach'
  resourceCleanups: (() => void)[]
  structuralOwnershipReleased: boolean
  postCleanups: (() => void)[] | null
}

const managedPaneTeardowns = new WeakMap<
  Map<number, ManagedPaneInternal>,
  Map<number, ManagedPaneTeardown>
>()

export function hasPendingManagedPaneTeardown(
  panes: Map<number, ManagedPaneInternal>,
  paneId: number
): boolean {
  return managedPaneTeardowns.get(panes)?.has(paneId) === true
}

export function teardownManagedPane(args: CloseManagedPaneArgs, reason: 'close' | 'detach'): void {
  let teardownsForPaneMap = managedPaneTeardowns.get(args.panes)
  if (!teardownsForPaneMap) {
    teardownsForPaneMap = new Map()
    managedPaneTeardowns.set(args.panes, teardownsForPaneMap)
  }
  let teardown = teardownsForPaneMap.get(args.paneId)
  const pane = teardown?.pane ?? args.panes.get(args.paneId)
  if (!pane) {
    return
  }
  if (teardown && teardown.reason !== reason) {
    throw new Error(`Pane ${args.paneId} teardown reason changed during retry`)
  }
  if (!teardown) {
    teardown = {
      pane,
      reason,
      resourceCleanups: [
        () => disposePane(pane, args.panes, { releaseOwnership: false }),
        () =>
          args.managerOptions.onPaneClosed?.(args.paneId, {
            paneId: args.paneId,
            leafId: pane.leafId,
            reason
          })
      ],
      structuralOwnershipReleased: false,
      postCleanups: null
    }
    teardownsForPaneMap.set(args.paneId, teardown)
  }

  runPaneCleanupLedger(teardown.resourceCleanups, 'Pane resource teardown failed')

  if (!teardown.structuralOwnershipReleased) {
    const cleanupErrors: unknown[] = []
    removePaneContainer(args, pane, cleanupErrors)
    if (cleanupErrors.length > 0 || pane.container.parentElement !== null) {
      // Why: the numeric/leaf identity remains claimed while either renderer
      // ownership is live, so the exact close can retry without aliasing a pane.
      throwPaneCleanupErrors(cleanupErrors, 'Pane teardown left a live pane')
      throw new Error('Pane teardown left a live pane')
    }
    if (args.panes.get(args.paneId) === pane) {
      args.panes.delete(args.paneId)
    }
    teardown.structuralOwnershipReleased = true
  }

  if (!teardown.postCleanups) {
    let nextActivePaneId: number | null = null
    const replacementCleanup = (): void => {
      const cleanupErrors: unknown[] = []
      nextActivePaneId = activateReplacementPane(args, cleanupErrors)
      throwPaneCleanupErrors(cleanupErrors, 'Pane replacement activation failed')
    }
    teardown.postCleanups = [
      () => args.releasePaneIdentity(args.paneId),
      replacementCleanup,
      () => applyPaneOpacity(args.panes.values(), nextActivePaneId, args.styleOptions),
      ...[...args.panes.values()].map((survivor) => () => safeFit(survivor)),
      () => updateMultiPaneState(args.getDragCallbacks()),
      ...(args.managerOptions.maintainOrchestrationGrid
        ? []
        : [() => args.managerOptions.onLayoutChanged?.()])
    ]
  }
  runPaneCleanupLedger(teardown.postCleanups, 'Pane teardown failed')
  teardownsForPaneMap.delete(args.paneId)
}

function removePaneContainer(
  args: CloseManagedPaneArgs,
  pane: ManagedPaneInternal,
  cleanupErrors: unknown[]
): void {
  const paneContainer = pane.container
  const parent = paneContainer.parentElement
  if (!parent) {
    return
  }
  if (parent.classList.contains('pane-split')) {
    let sibling: HTMLElement | null = null
    runPaneCleanupStep(cleanupErrors, () => {
      const siblings = findPaneChildren(parent)
      sibling = siblings.find((candidate) => candidate !== paneContainer) ?? null
    })
    runPaneCleanupStep(cleanupErrors, () => paneContainer.remove())
    runPaneCleanupStep(cleanupErrors, () => removeDividers(parent))
    runPaneCleanupStep(cleanupErrors, () => promoteSibling(sibling, parent, args.root))
  } else {
    runPaneCleanupStep(cleanupErrors, () => paneContainer.remove())
  }
  if (paneContainer.parentElement !== null) {
    // Why: a DOM removal failure must leave a discoverable pane for a safe retry.
    args.panes.set(pane.id, pane)
  }
}

function activateReplacementPane(
  args: CloseManagedPaneArgs,
  cleanupErrors: unknown[]
): number | null {
  if (args.activePaneId !== args.paneId) {
    return args.activePaneId
  }
  const next = args.panes.values().next().value as ManagedPaneInternal | undefined
  const nextActivePaneId = next?.id ?? null
  runPaneCleanupStep(cleanupErrors, () => args.setActivePaneId(nextActivePaneId))
  runPaneCleanupStep(cleanupErrors, () => next?.terminal.focus())
  return nextActivePaneId
}
