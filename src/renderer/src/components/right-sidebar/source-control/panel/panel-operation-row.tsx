import { useTranslate } from '@/i18n/use-translate'
import React from 'react'
import { useSequencerRecovery } from '../listing/use-sequencer-recovery'
import { OperationRow, type OperationRowOperation, type OperationRowPrimary } from './operation-row'
import {
  RebaseOperationRow,
  useConflictPrimary,
  type AbortChoice,
  type AbortOptions,
  type OperationRowAi
} from './rebase-operation-row'
import type { SourceControlPanelModel } from './use-panel-model'

/** The panel's paused rebase, merge, cherry-pick or revert, drawn in place of the HEAD row. */
export function SourceControlOperationRow({
  model,
  worktreeId
}: {
  model: SourceControlPanelModel
  worktreeId: string
}): React.JSX.Element | null {
  const t = useTranslate()
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
  // The paused run: a string binds the in-place confirm to it (main re-checks before aborting);
  // null means this host couldn't read it, so Abort is off (below); undefined is an older host,
  // which keeps the in-place confirm bound to HEAD and step only.
  const runIdentity = model.operationRunIdentity
  const abortOptions: AbortOptions = {
    confirmed: true,
    expectedRunIdentity: runIdentity ?? undefined
  }
  // Fails closed: without an owner, or on a current host that can't tell which run is paused, the
  // row can't bind a confirmation to a run, so Abort is off and says why.
  const blockedReason = !model.activeRepoTarget
    ? t(
        'auto.store.slices.editor.gitOperationTarget.unresolvedHost',
        'The workspace host is unresolved. Refresh the workspace and retry.'
      )
    : runIdentity === null
      ? t(
          'auto.components.right.sidebar.SourceControl.operationRunUnknown',
          "Can't tell which run is paused, so Abort is off here. Refresh Source Control, or abort it in a terminal."
        )
      : null
  const abortChoice: AbortChoice = { blockedReason }
  // Everything Abort would act on: workspace instance, Git owner, connection, operation, step and
  // the paused run itself.
  const abortTargetKey = JSON.stringify([
    worktreeId,
    model.activeWorktreeInstanceId ?? null,
    model.activeRepoTarget,
    model.activeConnectionId ?? null,
    operation,
    model.activeGitStatusHead ?? null,
    operation === 'rebase' ? (model.rebaseStop?.token ?? null) : null,
    runIdentity ?? null
  ])
  if (operation === 'rebase') {
    return model.baseRebaseState.kind === 'rebase_paused' ? (
      <RebaseOperationRow
        paused={model.baseRebaseState}
        branch={model.rebaseStop?.branch ?? headBranch}
        notes={[detachedNote]}
        ai={ai}
        abortTargetKey={abortTargetKey}
        abortChoice={abortChoice}
        actions={{
          state: model.baseRebaseState,
          isAbortingRebase: model.isAbortingOperation,
          isContinuingRebase: model.isContinuingRebase,
          isRetryingRebaseInspect: model.isRetryingRebaseInspect,
          hasGitOwner: !!model.activeRepoTarget,
          onAbortRebase: () => void model.handleAbortRebase(abortOptions),
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
        abortChoice={abortChoice}
        onAbort={() => void model.handleAbortMerge(abortOptions)}
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
      abortOptions={abortOptions}
      ai={ai}
      abortTargetKey={abortTargetKey}
      abortChoice={abortChoice}
    />
  )
}

function MergeOperationRow({
  model,
  branch,
  notes,
  unresolvedCount,
  ai,
  abortTargetKey,
  abortChoice,
  onAbort
}: {
  model: SourceControlPanelModel
  branch: string | null
  notes: (string | null)[]
  unresolvedCount: number
  ai: OperationRowAi
  abortTargetKey: string
  abortChoice: AbortChoice
  onAbort: () => void
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
        unavailable:
          model.isAbortingOperation || model.isCommitting || abortChoice.blockedReason !== null,
        busy: model.isAbortingOperation,
        reason: abortChoice.blockedReason,
        onAbort
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
  abortOptions,
  ai,
  abortTargetKey,
  abortChoice
}: {
  worktreeId: string
  operation: Exclude<OperationRowOperation, 'rebase' | 'merge'>
  branch: string | null
  notes: (string | null)[]
  unresolvedCount: number
  disabled: boolean
  hasGitOwner: boolean
  abortOptions: AbortOptions
  ai: OperationRowAi
  abortTargetKey: string
  abortChoice: AbortChoice
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
        unavailable:
          !recovery.supported ||
          !hasGitOwner ||
          disabled ||
          recovery.busyAction !== null ||
          abortChoice.blockedReason !== null,
        busy: recovery.busyAction === 'abort',
        reason: hostReason ?? abortChoice.blockedReason,
        onAbort: () => void recovery.run('abort', abortOptions)
      }}
      abortTargetKey={abortTargetKey}
    />
  )
}
