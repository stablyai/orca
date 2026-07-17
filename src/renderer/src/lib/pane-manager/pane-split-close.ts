import type {
  ManagedPane,
  ManagedPaneInternal,
  PaneManagerOptions,
  PaneSplitOptions,
  PaneStyleOptions
} from './pane-manager-types'
import type { DragReorderCallbacks } from './pane-drag-reorder'
import { updateMultiPaneState } from './pane-drag-reorder'
import { removeDividers, restoreScrollState, wrapInSplit } from './pane-tree-ops'
import { applyDividerStyles, applyPaneOpacity, disposeDivider } from './pane-divider'
import {
  disposePane,
  openTerminal,
  preparePanesForSplitMove,
  runPaneCleanupLedger,
  type MovedPaneSplitState
} from './pane-lifecycle'
import { clearPendingSplitScrollRestore, scheduleSplitScrollRestore } from './pane-split-scroll'
import { reattachWebglIfNeeded } from './pane-webgl-reattach'
import { toPublicPane } from './pane-public-view'
import {
  hasPendingManagedPaneTeardown,
  teardownManagedPane,
  type CloseManagedPaneArgs
} from './pane-teardown-transaction'

type SplitManagedPaneArgs = {
  paneId: number
  direction: 'vertical' | 'horizontal'
  opts?: PaneSplitOptions
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
  getActivePaneId?: () => number | null
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
  const previousActivePaneId = args.getActivePaneId?.() ?? null
  const sourceNextSibling = existingContainer.nextSibling
  const sourceStyle = existingContainer.style.cssText
  let newPane: ManagedPaneInternal | null = null
  let divider: HTMLElement | null = null
  let publishStarted = false
  let movedPaneStates: MovedPaneSplitState[] = []
  try {
    newPane = args.createPaneInternal(args.opts?.leafId)
    const isVertical = args.direction === 'vertical'
    divider = args.createDivider(isVertical)
    movedPaneStates = preparePanesForSplitMove(existingContainer, existing, args.panes)

    wrapInSplit(existingContainer, newPane.container, isVertical, divider, args.opts)
    if (args.opts?.activate !== false) {
      args.setActivePaneId(newPane.id)
    }
    openSplitPane(
      {
        ...args,
        publishPaneCreated: (pane, spawnHints) => {
          publishStarted = true
          args.publishPaneCreated(pane, spawnHints)
        }
      },
      newPane,
      args.opts?.cwd
    )

    for (const movedPaneState of movedPaneStates) {
      scheduleSplitScrollRestore(
        (id) => args.panes.get(id),
        movedPaneState.pane.id,
        movedPaneState.scrollState,
        args.isDestroyed,
        movedPaneState.shouldReattachWebgl ? reattachWebglIfNeeded : undefined
      )
    }

    return toPublicPane(newPane)
  } catch (error) {
    const rollback = createFailedSplitRollback({
      args,
      divider,
      existingContainer,
      movedPaneStates,
      newPane,
      parent,
      previousActivePaneId,
      publishStarted,
      sourceNextSibling,
      sourceStyle
    })
    try {
      rollback()
    } catch (firstRollbackError) {
      try {
        // Why: pane/resource ledgers retain only failed handles, so a transient
        // disposer must get one immediate retry before the split loses its caller.
        rollback()
      } catch (retryRollbackError) {
        const message = error instanceof Error ? error.message : 'Pane split failed'
        const firstMessage =
          firstRollbackError instanceof Error
            ? firstRollbackError.message
            : String(firstRollbackError)
        const retryMessage =
          retryRollbackError instanceof Error
            ? retryRollbackError.message
            : String(retryRollbackError)
        throw new AggregateError(
          [error, firstRollbackError, retryRollbackError],
          `${message}; split rollback failed twice: ${firstMessage}; ${retryMessage}`
        )
      }
    }
    throw error
  }
}

function createFailedSplitRollback(state: {
  args: SplitManagedPaneArgs
  divider: HTMLElement | null
  existingContainer: HTMLElement
  movedPaneStates: MovedPaneSplitState[]
  newPane: ManagedPaneInternal | null
  parent: HTMLElement
  previousActivePaneId: number | null
  publishStarted: boolean
  sourceNextSibling: ChildNode | null
  sourceStyle: string
}): () => void {
  const { args, newPane } = state
  const paneCleanups: (() => void)[] = []
  const publishedResourceCleanups: (() => void)[] = []
  const restorationCleanups: (() => void)[] = []
  if (newPane) {
    paneCleanups.push(() => disposePane(newPane, args.panes, { releaseOwnership: false }))
    if (state.publishStarted) {
      publishedResourceCleanups.push(() =>
        args.managerOptions.onPaneClosed?.(newPane.id, {
          paneId: newPane.id,
          leafId: newPane.leafId,
          reason: 'close'
        })
      )
    }
  }
  restorationCleanups.push(
    () => {
      state.existingContainer.style.cssText = state.sourceStyle
    },
    () => args.setActivePaneId(state.previousActivePaneId)
  )
  for (const moved of state.movedPaneStates) {
    restorationCleanups.push(
      () => restoreScrollState(moved.pane.terminal, moved.scrollState),
      () => {
        clearPendingSplitScrollRestore(moved.pane)
        moved.pane.pendingSplitScrollState = null
      }
    )
    if (moved.shouldReattachWebgl) {
      restorationCleanups.push(() => reattachWebglIfNeeded(moved.pane))
    }
  }
  const postCleanups: (() => void)[] = [
    () => applyPaneOpacity(args.panes.values(), state.previousActivePaneId, args.styleOptions),
    () => applyDividerStyles(args.root, args.styleOptions),
    () => updateMultiPaneState(args.getDragCallbacks())
  ]
  let structuralOwnershipReleased = false

  return () => {
    const cleanupErrors: unknown[] = []
    try {
      runPaneCleanupLedger(paneCleanups, 'Pane split resource rollback failed')
    } catch (error) {
      cleanupErrors.push(error)
    }
    try {
      runPaneCleanupLedger(
        publishedResourceCleanups,
        'Pane split published-resource rollback failed'
      )
    } catch (error) {
      cleanupErrors.push(error)
    }
    try {
      runPaneCleanupLedger(restorationCleanups, 'Pane split restoration failed')
    } catch (error) {
      cleanupErrors.push(error)
    }
    if (paneCleanups.length > 0) {
      throw new AggregateError(cleanupErrors, 'Pane split resource rollback failed')
    }
    if (!structuralOwnershipReleased) {
      const split = state.existingContainer.parentElement
      if (split && split !== state.parent && split.classList.contains('pane-split')) {
        removeDividers(split)
        state.parent.insertBefore(state.existingContainer, state.sourceNextSibling)
        newPane?.container.remove()
        split.remove()
      } else {
        if (state.divider) {
          disposeDivider(state.divider)
          state.divider.remove()
        }
        newPane?.container.remove()
      }
      if (newPane?.container.parentElement) {
        throw new Error('Pane split rollback left the partial pane mounted')
      }
      if (newPane && args.panes.get(newPane.id) === newPane) {
        args.panes.delete(newPane.id)
      }
      structuralOwnershipReleased = true
    }
    try {
      runPaneCleanupLedger(postCleanups, 'Pane split rollback failed')
    } catch (error) {
      cleanupErrors.push(error)
    }
    if (cleanupErrors.length === 1) {
      throw cleanupErrors[0]
    }
    if (cleanupErrors.length > 1) {
      throw new AggregateError(cleanupErrors, 'Pane split rollback failed')
    }
  }
}

function openSplitPane(
  args: SplitManagedPaneArgs,
  newPane: ManagedPaneInternal,
  cwd?: string
): void {
  openTerminal(newPane)
  const shouldActivate = args.opts?.activate !== false
  const activePaneId = shouldActivate ? newPane.id : (args.getActivePaneId?.() ?? null)
  applyPaneOpacity(args.panes.values(), activePaneId, args.styleOptions)
  applyDividerStyles(args.root, args.styleOptions)
  if (shouldActivate) {
    newPane.terminal.focus()
  }
  updateMultiPaneState(args.getDragCallbacks())
  // Why: forward one-shot spawn/adoption hints so the new pane inherits the
  // source cwd for local splits or attaches a runtime-spawned PTY for web splits.
  const spawnHints = {
    ...(cwd ? { cwd } : {}),
    ...(args.opts?.ptyId ? { ptyId: args.opts.ptyId } : {})
  }
  args.publishPaneCreated(newPane, Object.keys(spawnHints).length > 0 ? spawnHints : undefined)
  if (args.opts?.notifyLayoutChanged !== false) {
    args.managerOptions.onLayoutChanged?.()
  }
}

export function closeManagedPane(args: CloseManagedPaneArgs): void {
  teardownManagedPane(args, 'close')
}

export function detachManagedPaneForExternalMove(args: CloseManagedPaneArgs): boolean {
  const hasPendingTeardown = hasPendingManagedPaneTeardown(args.panes, args.paneId)
  // Why: refuse to detach the last pane — there is no other pane to fall back to.
  // A post-cleanup retry has already released structure and must resume anyway.
  if (!hasPendingTeardown && (!args.panes.has(args.paneId) || args.panes.size <= 1)) {
    return false
  }
  // Why: pane-to-tab detach tears down only this renderer pane; the PTY is
  // adopted by the new tab, so the 'detach' reason tells TerminalPane to skip
  // process-close cleanup.
  teardownManagedPane(args, 'detach')
  return true
}

