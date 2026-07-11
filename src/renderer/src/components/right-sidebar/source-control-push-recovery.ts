import {
  buildFixPushFailurePrompt,
  hasExpandedPushFailureDetails,
  isPushHookFailure,
  sanitizePushFailureDetails,
  summarizePushFailure
} from '../../../../shared/source-control-push-failure'
import type { SourceControlActionError } from './source-control-action-error'

export type SourceControlPushRecovery = {
  rawDetailText: string
  detailText: string
  summary: string
  hasDetails: boolean
  kindLabel: string | null
  prompt: string
}

function isPushRecoveryOperation(error: SourceControlActionError): boolean {
  if (error.kind === 'sync') {
    return error.syncPushStage === true
  }
  return error.kind === 'push' || error.kind === 'force_push' || error.kind === 'publish'
}

export function getSourceControlRecoveryFailureKindLabel(summary: string): string | null {
  if (/\blint\b/i.test(summary)) {
    return 'Lint'
  }

  if (/\bhook\b|\bpre-commit\b|\bpre-push\b/i.test(summary)) {
    return 'Hook'
  }

  return null
}

export function deriveSourceControlPushRecovery({
  actionError,
  currentBranchName,
  currentSequence
}: {
  actionError: SourceControlActionError | null
  currentBranchName: string | null
  currentSequence?: number | null
}): SourceControlPushRecovery | null {
  if (!actionError || !isPushRecoveryOperation(actionError)) {
    return null
  }

  if (
    typeof currentSequence === 'number' &&
    typeof actionError.sequence === 'number' &&
    currentSequence !== actionError.sequence
  ) {
    return null
  }

  if (actionError.branchName && currentBranchName && actionError.branchName !== currentBranchName) {
    return null
  }

  const rawError = actionError.rawError || actionError.message
  if (!isPushHookFailure(rawError)) {
    return null
  }

  const summary = summarizePushFailure(rawError)
  const detailText = sanitizePushFailureDetails(rawError)
  return {
    rawDetailText: rawError,
    detailText,
    summary,
    hasDetails: hasExpandedPushFailureDetails(rawError, summary),
    kindLabel: getSourceControlRecoveryFailureKindLabel(summary),
    prompt: buildFixPushFailurePrompt({
      summary,
      error: detailText,
      entries: actionError.entriesSnapshot ?? [],
      totalEntryCount: actionError.entriesSnapshotTotalCount,
      worktreePath: actionError.worktreePath ?? null,
      branchName: actionError.branchName ?? null
    })
  }
}
