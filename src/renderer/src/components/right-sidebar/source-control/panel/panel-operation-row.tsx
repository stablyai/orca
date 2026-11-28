import React from 'react'
import { useSequencerRecovery } from '../listing/use-sequencer-recovery'
import { OperationRow, type OperationRowOperation, type OperationRowPrimary } from './operation-row'
import { RebaseOperationRow, useConflictPrimary, type OperationRowAi } from './rebase-operation-row'
import type { SourceControlPanelModel } from './use-panel-model'

/** The panel's paused rebase, merge, cherry-pick or revert, drawn in place of the HEAD row. */
export function SourceControlOperationRow({
  model,
  worktreeId
}: {
  model: SourceControlPanelModel
  worktreeId: string
}): React.JSX.Element | null {
  const operation = model.conflictOperation
  const unresolvedCount = model.unresolvedConflictReviewEntries.length
  const recoveryBusy = model.isCheckingRecoveryAdmission || model.isResolvingConflictsWithAI
  const ai: OperationRowAi = model.sourceControlAiActionsVisible
    ? { busy: recoveryBusy, onPress: () => void model.handleResolveConflictsWithAI() }
    : null
  if (operation === 'unknown') {
    return null
  }
  const identity = model.gitIdentityDisplay
  // A rebase always detaches HEAD, so its sha moves into the tooltip instead of a pill.
  const detachedNote = identity?.kind === 'detached' ? identity.sourceControlLabel : null
  const headBranch = identity?.kind === 'branch' ? identity.branchName : null
  // Everything Abort would act on: workspace instance, Git owner, connection, operation and step.
  // Merge and sequencer stops carry no incarnation token; their end unmounts the row, clearing any arm.
  const abortTargetKey = JSON.stringify([
    worktreeId,
    model.activeWorktreeInstanceId ?? null,
    model.activeRepoTarget,
    model.activeConnectionId ?? null,
    operation,
    model.activeGitStatusHead ?? null,
    operation === 'rebase' ? (model.rebaseStop?.token ?? null) : null
  ])
  if (operation === 'rebase') {
    return model.baseRebaseState.kind === 'rebase_paused' ? (
      <RebaseOperationRow
        paused={model.baseRebaseState}
        branch={model.rebaseStop?.branch ?? headBranch}
        notes={[detachedNote]}
        ai={ai}
        abortTargetKey={abortTargetKey}
        actions={{
          state: model.baseRebaseState,
          isAbortingRebase: model.isAbortingOperation,
          isContinuingRebase: model.isContinuingRebase,
          isRetryingRebaseInspect: model.isRetryingRebaseInspect,
          hasGitOwner: !!model.activeRepoTarget,
          onAbortRebase: () => void model.handleAbortRebase({ confirmed: true }),
          onContinueRebase: () => void model.handleContinueRebase(),
          onRetryRebaseInspect: model.handleRetryRebaseInspect
        }}
      />
    ) : null
  }
  if (operation === 'merge') {
    return (
      <MergeOperationRow
        model={model}
        branch={headBranch}
        notes={[detachedNote]}
        unresolvedCount={unresolvedCount}
        ai={ai}
        abortTargetKey={abortTargetKey}
      />
    )
  }
  return (
    <SequencerOperationRow
      worktreeId={worktreeId}
      operation={operation}
      branch={headBranch}
      notes={[detachedNote]}
      unresolvedCount={unresolvedCount}
      disabled={recoveryBusy || model.isAbortingOperation || model.isCommitting}
      hasGitOwner={!!model.activeRepoTarget}
      ai={ai}
      abortTargetKey={abortTargetKey}
    />
  )
}

function MergeOperationRow({
  model,
  branch,
  notes,
  unresolvedCount,
  ai,
  abortTargetKey
}: {
  model: SourceControlPanelModel
  branch: string | null
  notes: (string | null)[]
  unresolvedCount: number
  ai: OperationRowAi
  abortTargetKey: string
}): React.JSX.Element {
  const conflict = useConflictPrimary(unresolvedCount, ai)
  // Eligibility first: nothing to press while an abort runs or with no Git owner to run it.
  const primary: OperationRowPrimary | null =
    model.isAbortingOperation || !model.activeRepoTarget
      ? null
      : conflict
        ? conflict.primary
        : {
            kind: 'continue',
            busy: model.isCommitting,
            onPress: () => void model.handleCompleteMerge()
          }
  return (
    <OperationRow
      operation="merge"
      branch={branch}
      notes={[...notes, conflict?.note ?? null]}
      primary={primary}
      abort={{
        unavailable: model.isAbortingOperation || model.isCommitting,
        busy: model.isAbortingOperation,
        onAbort: () => void model.handleAbortMerge({ confirmed: true })
      }}
      abortTargetKey={abortTargetKey}
    />
  )
}

function SequencerOperationRow({
  worktreeId,
  operation,
  branch,
  notes,
  unresolvedCount,
  disabled,
  hasGitOwner,
  ai,
  abortTargetKey
}: {
  worktreeId: string
  operation: Exclude<OperationRowOperation, 'rebase' | 'merge'>
  branch: string | null
  notes: (string | null)[]
  unresolvedCount: number
  disabled: boolean
  hasGitOwner: boolean
  ai: OperationRowAi
  abortTargetKey: string
}): React.JSX.Element {
  const recovery = useSequencerRecovery({
    worktreeId,
    operation,
    disabled: disabled || !hasGitOwner
  })
  const conflict = useConflictPrimary(unresolvedCount, ai)
  // An old host cannot run these; its reason replaces the step it cannot take.
  const hostReason = recovery.supported ? null : (recovery.reason ?? null)
  const continuing = recovery.busyAction === 'continue'
  // Eligibility first: nothing to press while an abort runs, on a host that can't run this
  // operation, or with no Git owner; the host's reason is in the tooltip.
  const primary: OperationRowPrimary | null =
    recovery.busyAction === 'abort' || hostReason || !hasGitOwner
      ? null
      : conflict
        ? conflict.primary
        : {
            kind: 'continue',
            busy: continuing || disabled,
            onPress: () => void recovery.run('continue')
          }
  return (
    <OperationRow
      operation={operation}
      branch={branch}
      notes={[...notes, conflict?.note ?? null, hostReason]}
      primary={primary}
      abort={{
        unavailable: !recovery.supported || disabled || recovery.busyAction !== null,
        busy: recovery.busyAction === 'abort',
        reason: hostReason,
        onAbort: () => void recovery.run('abort', { confirmed: true })
      }}
      abortTargetKey={abortTargetKey}
    />
  )
}
