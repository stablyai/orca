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
import { clearPendingSplitScrollRestore, scheduleSplitScrollRestore } from './pane-split-scroll'
import { reattachWebglIfNeeded } from './pane-webgl-reattach'
import { toPublicPane } from './pane-public-view'

type MovedPaneSplitState = {
  pane: ManagedPaneInternal
  scrollState: ReturnType<typeof captureScrollState>
  hadWebgl: boolean
}

type SplitManagedPaneArgs = {
  paneId: number
  direction: 'vertical' | 'horizontal'
  opts?: { ratio?: number; cwd?: string; leafId?: string; ptyId?: string }
  sourceContainer?: HTMLElement
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
  const existingContainer = args.sourceContainer ?? existing.container
  const parent = existingContainer.parentElement
  if (!parent) {
    return null
  }
  const newPane = args.createPaneInternal(args.opts?.leafId)
  const isVertical = args.direction === 'vertical'
  const divider = args.createDivider(isVertical)

  const movedPaneStates = prepareMovedPanesForSplit(existingContainer, existing, args.panes)

  wrapInSplit(existingContainer, newPane.container, isVertical, divider, args.opts)
  args.setActivePaneId(newPane.id)
  openSplitPane(args, newPane, args.opts?.cwd)

  for (const movedPaneState of movedPaneStates) {
    scheduleSplitScrollRestore(
      (id) => args.panes.get(id),
      movedPaneState.pane.id,
      movedPaneState.scrollState,
      args.isDestroyed,
      movedPaneState.hadWebgl ? reattachWebglIfNeeded : undefined
    )
  }

  return toPublicPane(newPane)
}

function prepareMovedPanesForSplit(
  sourceContainer: HTMLElement,
  fallbackPane: ManagedPaneInternal,
  panes: Map<number, ManagedPaneInternal>
): MovedPaneSplitState[] {
  const movedPanes = findManagedPanesInContainer(sourceContainer, panes)
  if (movedPanes.length === 0) {
    movedPanes.push(fallbackPane)
  }

  return movedPanes.map((pane) => {
    clearPendingSplitScrollRestore(pane)
    // Why: wrapInSplit reparents moved containers, resetting browser scrollTop.
    const scrollState = captureScrollState(pane.terminal)
    // Why: lock prevents safeFit/fitAllPanes from restoring scroll during the
    // async settle window; scheduleSplitScrollRestore owns the restore.
    pane.pendingSplitScrollState = scrollState

    // Why: DOM reparenting can silently invalidate a WebGL context without
    // firing contextlost, so dispose before the move and reattach after settle.
    const hadWebgl = !!pane.webglAddon
    disposeWebgl(pane)
    return { pane, scrollState, hadWebgl }
  })
}

function findManagedPanesInContainer(
  sourceContainer: HTMLElement,
  panes: Map<number, ManagedPaneInternal>
): ManagedPaneInternal[] {
  const movedPanes: ManagedPaneInternal[] = []
  const appendPaneById = (paneIdValue: string | undefined): void => {
    if (!paneIdValue) {
      return
    }
    const paneId = Number(paneIdValue)
    if (!Number.isFinite(paneId)) {
      return
    }
    const pane = panes.get(paneId)
    if (pane && !movedPanes.includes(pane)) {
      movedPanes.push(pane)
    }
  }

  if (sourceContainer.classList.contains('pane')) {
    appendPaneById(sourceContainer.dataset.paneId)
  }
  for (const paneElement of sourceContainer.querySelectorAll<HTMLElement>('.pane[data-pane-id]')) {
    appendPaneById(paneElement.dataset.paneId)
  }
  return movedPanes
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
  // Why: forward one-shot spawn/adoption hints so the new pane inherits the
  // source cwd for local splits or attaches a runtime-spawned PTY for web splits.
  const spawnHints = {
    ...(cwd ? { cwd } : {}),
    ...(args.opts?.ptyId ? { ptyId: args.opts.ptyId } : {})
  }
  args.publishPaneCreated(newPane, Object.keys(spawnHints).length > 0 ? spawnHints : undefined)
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
  args.managerOptions.onPaneClosed?.(args.paneId, {
    paneId: args.paneId,
    leafId: closedLeafId,
    reason: 'close'
  })
  args.managerOptions.onLayoutChanged?.()
}

export function detachManagedPaneForExternalMove(args: CloseManagedPaneArgs): boolean {
  const pane = args.panes.get(args.paneId)
  if (!pane || args.panes.size <= 1) {
    return false
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
  // Why: pane-to-tab detach tears down only this renderer pane; the PTY is
  // adopted by the new tab, so TerminalPane must skip process-close cleanup.
  args.managerOptions.onPaneClosed?.(args.paneId, {
    paneId: args.paneId,
    leafId: closedLeafId,
    reason: 'detach'
  })
  args.managerOptions.onLayoutChanged?.()
  return true
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
