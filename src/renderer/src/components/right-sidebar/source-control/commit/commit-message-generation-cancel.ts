import { cancelRuntimeGenerateCommitMessage } from '@/runtime/runtime-git-generation-client'
import { getConnectionId } from '@/lib/connection-context'
import type { RuntimeClientTarget } from '../../../../../../shared/runtime-client-target'
import {
  resolveCommitMessageGenerationCancel,
  type CommitMessageGenerationRecord,
  type CommitMessageGenerationSlice
} from '@/store/slices/commit-message-generation'
import type { CreatePrIntentRunToken } from '../review/create-pr-intent-flow'

export function cancelCommitMessageGenerationRequest({
  key,
  worktreeId,
  worktreePath,
  ownerTarget,
  record,
  inFlight,
  intentTokens,
  updateRecord
}: {
  key: string | null
  worktreeId: string | null
  worktreePath: string | null
  ownerTarget: RuntimeClientTarget | null
  record: CommitMessageGenerationRecord | null
  inFlight: Record<string, boolean>
  intentTokens: Record<string, CreatePrIntentRunToken | null>
  updateRecord: CommitMessageGenerationSlice['updateCommitMessageGenerationRecord']
}): void {
  if (!key || !worktreeId || !worktreePath || !inFlight[worktreeId]) {
    return
  }
  const context =
    intentTokens[worktreeId]?.commitMessageGeneration ??
    (record?.context ? { ...record.context, target: record.context.runtimeTarget } : undefined)
  if (context?.generationCancellation) {
    context.generationCancellation.canceled = true
  }
  updateRecord(key, resolveCommitMessageGenerationCancel)
  // The in-flight promise clears the spinner after the original owner settles.
  if (!context) {
    // No identity to cancel by: keep the legacy path-based Stop through the workspace owner.
    if (ownerTarget) {
      void cancelRuntimeGenerateCommitMessage({
        target: ownerTarget,
        worktreeId,
        worktreePath,
        connectionId: getConnectionId(worktreeId) ?? undefined
      })
    }
    return
  }
  void cancelRuntimeGenerateCommitMessage({
    target: context.target,
    worktreeId: context.worktreeId,
    worktreePath: context.worktreePath,
    connectionId: context.connectionId,
    generationId: context.generationId
  })
}
