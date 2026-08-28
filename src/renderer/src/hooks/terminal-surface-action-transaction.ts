import { useAppStore } from '../store'
import type {
  SplitTerminalPaneAcknowledgement,
  SplitTerminalPaneDetail
} from '@/constants/terminal'
import { SPLIT_TERMINAL_PANE_EVENT } from '@/constants/terminal'
import type { AppState } from '../store/types'
import type { TerminalLayoutSnapshot } from '../../../shared/types'
import {
  collectTerminalLayoutLeafIds,
  reflowOrchestrationTerminalGrid
} from '../../../shared/orchestration-terminal-grid'
import { detachTerminalLayoutLeaf } from '@/components/terminal-pane/terminal-layout-leaf-detach'
import type { TerminalSurfaceActionCancellationReason } from './terminal-surface-action-queue'

export type SuccessfulTerminalPaneSplit = Extract<
  SplitTerminalPaneAcknowledgement,
  { status: 'success' }
>

export function terminalTransactionErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function preserveTerminalTransactionError(
  operationError: unknown,
  cleanupError: unknown,
  cleanupLabel: string
): AggregateError {
  return new AggregateError(
    [operationError, cleanupError],
    `${terminalTransactionErrorMessage(operationError)}; ${cleanupLabel}: ${terminalTransactionErrorMessage(cleanupError)}`
  )
}

function rollbackAcknowledgedTerminalPaneSplit(result: SuccessfulTerminalPaneSplit): void {
  let firstError: unknown
  try {
    result.rollback()
    return
  } catch (error) {
    firstError = error
  }
  try {
    // Why: low-level teardown keeps rollback retryable after cleanup throws;
    // consume that retained ownership before the acknowledgement is lost.
    result.rollback()
  } catch (retryError) {
    throw new AggregateError(
      [firstError, retryError],
      `Terminal split rollback failed twice: ${terminalTransactionErrorMessage(firstError)}; ${terminalTransactionErrorMessage(retryError)}`
    )
  }
}

function rollbackAcknowledgedTerminalPaneSplits(
  acknowledgements: readonly SplitTerminalPaneAcknowledgement[]
): void {
  const cleanupErrors: unknown[] = []
  for (const acknowledgement of acknowledgements) {
    if (acknowledgement.status !== 'success') {
      continue
    }
    try {
      rollbackAcknowledgedTerminalPaneSplit(acknowledgement)
    } catch (error) {
      cleanupErrors.push(error)
    }
  }
  if (cleanupErrors.length === 1) {
    throw cleanupErrors[0]
  }
  if (cleanupErrors.length > 1) {
    throw new AggregateError(cleanupErrors, 'Terminal split rollbacks failed')
  }
}

export function dispatchAcknowledgedTerminalPaneSplit(
  detail: SplitTerminalPaneDetail
): SuccessfulTerminalPaneSplit {
  const acknowledgements: SplitTerminalPaneAcknowledgement[] = []
  const acknowledgedDetail: SplitTerminalPaneDetail = {
    ...detail,
    acknowledge: (result) => acknowledgements.push(result)
  }
  try {
    window.dispatchEvent(
      new CustomEvent<SplitTerminalPaneDetail>(SPLIT_TERMINAL_PANE_EVENT, {
        detail: acknowledgedDetail
      })
    )
  } catch (error) {
    try {
      rollbackAcknowledgedTerminalPaneSplits(acknowledgements)
    } catch (cleanupError) {
      throw preserveTerminalTransactionError(error, cleanupError, 'split rollback failed')
    }
    throw error
  }

  if (acknowledgements.length !== 1) {
    const acknowledgementError = new Error(
      acknowledgements.length === 0
        ? `Terminal split event for ${detail.tabId} was not acknowledged`
        : `Terminal split event for ${detail.tabId} was acknowledged ${acknowledgements.length} times`
    )
    try {
      rollbackAcknowledgedTerminalPaneSplits(acknowledgements)
    } catch (cleanupError) {
      throw preserveTerminalTransactionError(
        acknowledgementError,
        cleanupError,
        'split rollback failed'
      )
    }
    throw acknowledgementError
  }
  const acknowledgement = acknowledgements[0]!
  if (acknowledgement.status === 'failure') {
    throw acknowledgement.error instanceof Error
      ? acknowledgement.error
      : new Error(String(acknowledgement.error))
  }
  return acknowledgement
}

export function runTerminalSurfaceActionTransaction(
  commit: (
    store: AppState,
    registerSplit: (split: SuccessfulTerminalPaneSplit) => void
  ) => (() => void) | undefined
): void {
  const actionStore = useAppStore.getState()
  const stateBeforeAction = { ...actionStore }
  let split: SuccessfulTerminalPaneSplit | undefined
  let afterCommit: (() => void) | undefined
  try {
    afterCommit = commit(actionStore, (nextSplit) => {
      if (split) {
        const duplicateSplitError = new Error(
          'Terminal surface action registered more than one split'
        )
        try {
          rollbackAcknowledgedTerminalPaneSplit(nextSplit)
        } catch (cleanupError) {
          throw preserveTerminalTransactionError(
            duplicateSplitError,
            cleanupError,
            'duplicate split rollback failed'
          )
        }
        throw duplicateSplitError
      }
      split = nextSplit
    })
  } catch (error) {
    let cleanupError: unknown
    try {
      // Why: pane resources live outside Zustand, so they must disappear
      // before the renderer snapshot becomes canonical again.
      if (split) {
        rollbackAcknowledgedTerminalPaneSplit(split)
      }
    } catch (rollbackError) {
      cleanupError = rollbackError
    } finally {
      useAppStore.setState(stateBeforeAction, true)
    }
    if (cleanupError !== undefined) {
      throw preserveTerminalTransactionError(error, cleanupError, 'split rollback failed')
    }
    throw error
  }
  try {
    split?.afterCommit?.()
  } catch {
    // Why: telemetry is best-effort after both pane and store are committed.
  }
  try {
    afterCommit?.()
  } catch {
    // Why: focus is best-effort and cannot reclassify a committed pane request.
  }
}

export function createCommittedTerminalGridAppendRollback(args: {
  tabId: string
  leafId: string
  ptyId: string
  priorLayout: TerminalLayoutSnapshot
  split: SuccessfulTerminalPaneSplit
}): () => void {
  let paneRolledBack = false
  let layoutRolledBack = false
  let bindingCleared = false
  return () => {
    if (!paneRolledBack) {
      rollbackAcknowledgedTerminalPaneSplit(args.split)
      paneRolledBack = true
    }
    const store = useAppStore.getState()
    if (!layoutRolledBack) {
      const currentLayout = store.terminalLayoutsByTabId?.[args.tabId]
      const currentLeafIds = collectTerminalLayoutLeafIds(currentLayout?.root)
      if (currentLeafIds.includes(args.leafId)) {
        const detached = detachTerminalLayoutLeaf(currentLayout, args.leafId)
        if (!detached) {
          throw new Error(`Terminal grid append ${args.leafId} could not be detached`)
        }
        const remainingLeafIds = collectTerminalLayoutLeafIds(detached.sourceLayout.root)
        const priorActiveLeafId = args.priorLayout.activeLeafId
        const activeLeafId =
          priorActiveLeafId && remainingLeafIds.includes(priorActiveLeafId)
            ? priorActiveLeafId
            : detached.sourceLayout.activeLeafId
        const priorExpandedLeafId = args.priorLayout.expandedLeafId
        store.setTabLayout(args.tabId, {
          ...reflowOrchestrationTerminalGrid(detached.sourceLayout, remainingLeafIds, activeLeafId),
          expandedLeafId:
            priorExpandedLeafId && remainingLeafIds.includes(priorExpandedLeafId)
              ? priorExpandedLeafId
              : null
        })
      }
      layoutRolledBack = true
    }
    if (!bindingCleared) {
      store.clearTabPtyId(args.tabId, args.ptyId)
      bindingCleared = true
    }
  }
}

export function terminalSurfaceActionFailureMessage(
  tabId: string,
  reason: TerminalSurfaceActionCancellationReason,
  error?: unknown
): string {
  if (reason === 'action-failed' && error instanceof Error) {
    return error.message
  }
  switch (reason) {
    case 'timeout':
      return `Terminal surface ${tabId} did not mount before the split deadline`
    case 'tab-removed':
      return `Terminal tab ${tabId} was removed before the split was applied`
    case 'surface-unmounted':
      return `Terminal surface ${tabId} was torn down before the split was applied`
    case 'ipc-events-disposed':
      return `Terminal creation was cancelled while the renderer was shutting down`
    case 'action-failed':
      return `Terminal split failed for ${tabId}`
    case 'cancelled':
      return `Terminal split was cancelled for ${tabId}`
  }
}
