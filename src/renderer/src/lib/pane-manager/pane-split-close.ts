import type {
  ManagedPane,
  ManagedPaneInternal,
  PaneManagerOptions,
  PaneStyleOptions
} from './pane-manager-types'
import type { DragReorderCallbacks } from './pane-drag-reorder'
import { updateMultiPaneState } from './pane-drag-reorder'
import {
  captureScrollState,
  findPaneChildren,
  promoteSibling,
  removeDividers,
  safeFit,
  wrapInSplit
} from './pane-tree-ops'
import { applyDividerStyles, applyPaneOpacity } from './pane-divider'
import { disposePane, openTerminal } from './pane-lifecycle'
import { disposeWebgl } from './pane-webgl-renderer'
import { scheduleSplitScrollRestore } from './pane-split-scroll'
import { reattachWebglIfNeeded } from './pane-webgl-reattach'
import { toPublicPane } from './pane-public-view'

type SplitManagedPaneArgs = {
  paneId: number
  direction: 'vertical' | 'horizontal'
  opts?: { ratio?: number; cwd?: string; leafId?: string }
  panes: Map<number, ManagedPaneInternal>
  root: HTMLElement
  styleOptions: PaneStyleOptions
  managerOptions: PaneManagerOptions
  createPaneInternal: (leafIdHint?: string) => ManagedPaneInternal
  createDivider: (isVertical: boolean) => HTMLElement
  publishPaneCreated: (
    pane: ManagedPaneInternal,
    spawnHints?: Parameters<NonNullable<PaneManagerOptions['onPaneCreated']>>[1]
  ) => void
  getDragCallbacks: () => DragReorderCallbacks
  setActivePaneId: (paneId: number | null) => void
  isDestroyed: () => boolean
}

export function splitManagedPane(args: SplitManagedPaneArgs): ManagedPane | null {
  const existing = args.panes.get(args.paneId)
  if (!existing) {
    return null
  }
  const parent = existing.container.parentElement
  if (!parent) {
    return null
  }
  const newPane = args.createPaneInternal(args.opts?.leafId)
  const isVertical = args.direction === 'vertical'
  const divider = args.createDivider(isVertical)

  // Why: wrapInSplit reparents the existing container, resetting scrollTop.
  const scrollState = captureScrollState(existing.terminal)
  // Why: lock prevents safeFit/fitAllPanes from restoring scroll during the
  // async settle window; scheduleSplitScrollRestore owns the restore.
  existing.pendingSplitScrollState = scrollState

  // Why: DOM reparenting can silently invalidate a WebGL context without
  // firing contextlost, so dispose before the move and reattach after settle.
  const hadWebgl = !!existing.webglAddon
  disposeWebgl(existing)

  wrapInSplit(existing.container, newPane.container, isVertical, divider, args.opts)
  args.setActivePaneId(newPane.id)
  openSplitPane(args, newPane, args.opts?.cwd)

  scheduleSplitScrollRestore(
    (id) => args.panes.get(id),
    existing.id,
    scrollState,
    args.isDestroyed,
    hadWebgl ? reattachWebglIfNeeded : undefined
  )

  return toPublicPane(newPane)
}

function openSplitPane(
  args: SplitManagedPaneArgs,
  newPane: ManagedPaneInternal,
  cwd?: string
): void {
  openTerminal(newPane)
  applyPaneOpacity(args.panes.values(), newPane.id, args.styleOptions)
  applyDividerStyles(args.root, args.styleOptions)
  newPane.terminal.focus()
  updateMultiPaneState(args.getDragCallbacks())
  // Why: forward cwd hint so the new PTY spawns in the source pane's cwd.
  args.publishPaneCreated(newPane, cwd ? { cwd } : undefined)
  args.managerOptions.onLayoutChanged?.()
}

type CloseManagedPaneArgs = {
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

export function closeManagedPane(args: CloseManagedPaneArgs): void {
  const pane = args.panes.get(args.paneId)
  if (!pane) {
    return
  }
  const closedLeafId = pane.leafId
  args.releasePaneIdentity(args.paneId)
  removePaneContainer(args, pane)
  const nextActivePaneId = activateReplacementPane(args)
  applyPaneOpacity(args.panes.values(), nextActivePaneId, args.styleOptions)
  for (const p of args.panes.values()) {
    safeFit(p)
  }
  updateMultiPaneState(args.getDragCallbacks())
  args.managerOptions.onPaneClosed?.(args.paneId, { paneId: args.paneId, leafId: closedLeafId })
  args.managerOptions.onLayoutChanged?.()
}

function removePaneContainer(args: CloseManagedPaneArgs, pane: ManagedPaneInternal): void {
  const paneContainer = pane.container
  const parent = paneContainer.parentElement
  disposePane(pane, args.panes)
  if (!parent) {
    return
  }
  if (parent.classList.contains('pane-split')) {
    const siblings = findPaneChildren(parent)
    const sibling = siblings.find((c) => c !== paneContainer) ?? null
    paneContainer.remove()
    removeDividers(parent)
    promoteSibling(sibling, parent, args.root)
  } else {
    paneContainer.remove()
  }
}

function activateReplacementPane(args: CloseManagedPaneArgs): number | null {
  if (args.activePaneId !== args.paneId) {
    return args.activePaneId
  }
  const next = args.panes.values().next().value as ManagedPaneInternal | undefined
  const nextActivePaneId = next?.id ?? null
  args.setActivePaneId(nextActivePaneId)
  next?.terminal.focus()
  return nextActivePaneId
}
