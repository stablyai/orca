import React from 'react'
import { useTranslate } from '@/i18n/use-translate'
import type { BaseRebaseState } from './base-rebase-state'
import { OperationRow, type OperationRowPrimary, type OperationRowProps } from './operation-row'

export type BaseRebaseActions = {
  state: BaseRebaseState
  isAbortingRebase: boolean
  isContinuingRebase: boolean
  isRetryingRebaseInspect: boolean
  hasGitOwner: boolean
  onAbortRebase: () => void
  onContinueRebase: () => void
  onRetryRebaseInspect: () => void
}

export type PausedRebase = Extract<BaseRebaseState, { kind: 'rebase_paused' }>

/** Resolve-with-AI while conflicts remain, when AI actions are on; null when they are off. */
export type OperationRowAi = { busy: boolean; onPress: () => void } | null

/** Conflicts take the primary slot: Resolve with AI, or nothing (never a greyed Continue). */
export function useConflictPrimary(
  unresolvedCount: number,
  ai: OperationRowAi
): { primary: OperationRowPrimary | null; note: string | null } | null {
  const t = useTranslate()
  if (unresolvedCount === 0) {
    return null
  }
  return ai
    ? { primary: { kind: 'resolve', ...ai }, note: null }
    : {
        primary: null,
        note: t(
          'auto.components.right.sidebar.SourceControl.rebaseResolveConflictsFirst',
          'Resolve conflicts first'
        )
      }
}

const NO_NOTES: (string | null)[] = []

export function RebaseOperationRow({
  actions,
  paused,
  branch,
  notes = NO_NOTES,
  ai,
  abortTargetKey
}: {
  actions: BaseRebaseActions
  paused: PausedRebase
  branch: string | null
  notes?: (string | null)[]
  ai: OperationRowAi
  abortTargetKey: string
}): React.JSX.Element {
  const t = useTranslate()
  const conflict = useConflictPrimary(paused.unresolvedCount, ai)
  const busy = actions.isAbortingRebase || !actions.hasGitOwner
  let primary: OperationRowPrimary | null = null
  let note: string | null = null
  if (paused.continueState === 'unreadable' || actions.isRetryingRebaseInspect) {
    primary = {
      kind: 'retry',
      busy: actions.isRetryingRebaseInspect,
      onPress: actions.onRetryRebaseInspect
    }
  } else if (conflict) {
    ;({ primary, note } = conflict)
  } else if (paused.continueState === 'ready' || actions.isContinuingRebase) {
    primary = {
      kind: 'continue',
      busy: actions.isContinuingRebase,
      onPress: actions.onContinueRebase
    }
  } else {
    // No step to take here: Git stopped for its own reason, or the step is still being read.
    note =
      paused.continueState === 'unknown'
        ? t(
            'auto.components.right.sidebar.SourceControl.rebaseCheckingStep',
            'Checking the rebase step'
          )
        : t(
            'auto.components.right.sidebar.SourceControl.rebaseStoppedFinishInTerminal',
            'Git paused this step. Finish it in a terminal or abort.'
          )
  }
  const abort: OperationRowProps['abort'] = {
    unavailable: actions.isAbortingRebase || actions.isContinuingRebase,
    busy: actions.isAbortingRebase && !actions.isContinuingRebase,
    onAbort: actions.onAbortRebase
  }
  return (
    <OperationRow
      operation="rebase"
      branch={branch}
      detail={
        paused.continueState === 'unreadable'
          ? t(
              'auto.components.right.sidebar.SourceControl.rebaseStepUnreadableShort',
              'Check failed'
            )
          : paused.continueState === 'empty' && paused.unresolvedCount === 0
            ? t('auto.components.right.sidebar.SourceControl.rebaseEmptyStepShort', 'Empty step')
            : null
      }
      notes={[
        ...notes,
        note,
        paused.continueState === 'unreadable' ? paused.inspectFailureMessage : null
      ]}
      // While aborting, or without a Git owner, nothing can run; the primary waits rather than greying out.
      primary={busy ? null : primary}
      abort={abort}
      abortTargetKey={abortTargetKey}
    />
  )
}
