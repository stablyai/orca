import { getRepoExecutionHostId } from '../../../../../../shared/execution-host'
import { getWorkspaceJiraIssueKey } from '../../../../../../shared/jira/jira-review-title'
import { useCallback } from 'react'
import { getConnectionId } from '@/lib/connection-context'
import { resolveWorktreeGitCopyNow } from '@/lib/worktree-git-copy'
import {
  cancelRuntimeGeneratePullRequestFields,
  generateRuntimePullRequestFields
} from '@/runtime/runtime-git-generation-client'
import type { RuntimeGeneratePullRequestFieldsOverrides } from '@/runtime/runtime-git-client-context'
import type { PullRequestGenerationOutcome } from '../../create-pull-request-dialog-field-model'
import { settlePullRequestGenerationRequest } from '../../pull-request-generation-request-outcome'
import { useAppStore } from '@/store'
import {
  createRunningPullRequestGenerationRecord,
  getPullRequestGenerationRecordKey,
  getPullRequestGenerationSeedRestoreKey,
  markPullRequestGenerationTerminalSeedRestored,
  resolvePullRequestGenerationCancel,
  resolvePullRequestGenerationFailure,
  resolvePullRequestGenerationSuccess,
  type PullRequestFieldRevisions,
  type PullRequestGenerationContext,
  type PullRequestGenerationFields
} from '@/store/slices/pull-request-generation'
import type { PullRequestGenerationOptions } from '@/store/slices/pull-request-generation-auto-submit'
import type { HostedReviewProvider } from '../../../../../../shared/hosted-review'
import type { SourceControlAi } from '../ai/use-ai'
import { stripBaseRef } from '../../create-pull-request-base-ref-normalization'
import type { SourceControlStoreActions } from '../listing/use-store-actions'
import type { SourceControlWorktreeContext } from '../listing/use-worktree-context'
import type { SourceControlStatusRefresh } from '../sync/use-status-refresh'

/** Persist generation in a store record so the composer can resume after tab switches. */
export function useSourceControlPullRequestGeneration({
  activeRepo,
  activeRepoTarget,
  activeWorktreeId,
  allocatePullRequestGenerationRequestId,
  branchName,
  hostedReviewCreateProvider,
  prGenerationRecords,
  refreshGitStatusAfterPullRequestGeneration,
  resolvedPrCreationDefaults,
  setPullRequestGenerationRecord,
  updatePullRequestGenerationRecord,
  worktreePath
}: {
  activeRepo: SourceControlWorktreeContext['activeRepo']
  activeRepoTarget: SourceControlWorktreeContext['activeRepoTarget']
  activeWorktreeId: string | null
  allocatePullRequestGenerationRequestId: SourceControlStoreActions['allocatePullRequestGenerationRequestId']
  branchName: string
  hostedReviewCreateProvider: HostedReviewProvider
  prGenerationRecords: SourceControlStoreActions['prGenerationRecords']
  refreshGitStatusAfterPullRequestGeneration: SourceControlStatusRefresh['refreshGitStatusAfterPullRequestGeneration']
  resolvedPrCreationDefaults: SourceControlAi['resolvedPrCreationDefaults']
  setPullRequestGenerationRecord: SourceControlStoreActions['setPullRequestGenerationRecord']
  updatePullRequestGenerationRecord: SourceControlStoreActions['updatePullRequestGenerationRecord']
  worktreePath: string | null
}) {
  const activePullRequestGenerationKey = getPullRequestGenerationRecordKey({
    worktreeId: activeWorktreeId,
    worktreePath,
    repoId: activeRepo?.id,
    branch: branchName
  })
  const activePullRequestGenerationRecordCandidate = activePullRequestGenerationKey
    ? (prGenerationRecords[activePullRequestGenerationKey] ?? null)
    : null
  const activePullRequestGenerationRecord =
    activePullRequestGenerationRecordCandidate &&
    activePullRequestGenerationRecordCandidate.context.repoId === activeRepo?.id &&
    activePullRequestGenerationRecordCandidate.context.branch === branchName
      ? activePullRequestGenerationRecordCandidate
      : null
  const activePullRequestGenerationSeedRestoreKey = getPullRequestGenerationSeedRestoreKey({
    recordKey: activePullRequestGenerationKey,
    record: activePullRequestGenerationRecord
  })

  const handleGeneratePullRequestFieldsForActive = useCallback(
    async (
      fields: PullRequestGenerationFields,
      fieldRevisions: PullRequestFieldRevisions,
      overrides?: RuntimeGeneratePullRequestFieldsOverrides,
      options?: PullRequestGenerationOptions
    ): Promise<PullRequestGenerationOutcome | undefined> => {
      if (
        !activeRepo ||
        !activeRepoTarget ||
        !activePullRequestGenerationKey ||
        !worktreePath ||
        !branchName
      ) {
        return undefined
      }
      const generationKey = activePullRequestGenerationKey
      if (
        useAppStore.getState().pullRequestGenerationRecords[generationKey]?.status === 'running'
      ) {
        return undefined
      }
      const requestId = allocatePullRequestGenerationRequestId()
      // Why one resolution: the result must land on this copy, not a same-path twin.
      const copy = activeWorktreeId ? resolveWorktreeGitCopyNow(activeWorktreeId) : null
      const context: PullRequestGenerationContext = {
        worktreeId: activeWorktreeId,
        worktreePath,
        connectionId: copy ? copy.connectionId : (getConnectionId(activeWorktreeId) ?? undefined),
        ownerHostId: copy?.hostId ?? null,
        jiraIssueKey:
          (hostedReviewCreateProvider === 'github' || hostedReviewCreateProvider === 'gitlab') &&
          activeWorktreeId
            ? getWorkspaceJiraIssueKey(
                useAppStore
                  .getState()
                  .getKnownWorktreeById(activeWorktreeId, getRepoExecutionHostId(activeRepo))
              )
            : null,
        requestId,
        repoId: activeRepo.id,
        branch: branchName,
        runtimeTarget: copy?.transport ?? activeRepoTarget
      }
      const seed = { ...fields }
      setPullRequestGenerationRecord(
        generationKey,
        createRunningPullRequestGenerationRecord(context, seed, fieldRevisions, options?.autoSubmit)
      )

      const request = (async (): Promise<void> => {
        try {
          const result = await generateRuntimePullRequestFields(
            {
              // Route generation to the repo owner, which may differ from the focused host.
              target: context.runtimeTarget,
              prefs: useAppStore.getState().settings,
              worktreeId: context.worktreeId,
              worktreePath: context.worktreePath,
              connectionId: context.connectionId
            },
            {
              base: stripBaseRef(seed.base.trim()),
              title: seed.title,
              body: seed.body,
              draft: seed.draft,
              provider: hostedReviewCreateProvider,
              useTemplate: resolvedPrCreationDefaults.useTemplate
            },
            overrides
          )
          if (result.branchChangedByPreparation) {
            await refreshGitStatusAfterPullRequestGeneration(context)
          }
          if (result.success) {
            useAppStore.getState().recordFeatureInteraction('ai-pr-generation')
          }
          updatePullRequestGenerationRecord(generationKey, (record) => {
            if (!result.success) {
              return resolvePullRequestGenerationFailure({
                record,
                requestId,
                canceled: result.canceled,
                error: result.canceled ? null : result.error
              })
            }
            if (!record) {
              return null
            }
            return resolvePullRequestGenerationSuccess({
              record,
              requestId,
              result: {
                base: stripBaseRef(result.fields.base),
                title: result.fields.title,
                body: result.fields.body,
                draft: result.fields.draft
              }
            })
          })
        } catch (error) {
          updatePullRequestGenerationRecord(generationKey, (record) =>
            resolvePullRequestGenerationFailure({
              record,
              requestId,
              error:
                error instanceof Error ? error.message : 'Failed to generate pull request details'
            })
          )
        }
      })()
      return await settlePullRequestGenerationRequest(generationKey, requestId, request)
    },
    [
      activePullRequestGenerationKey,
      activeRepo,
      activeRepoTarget,
      activeWorktreeId,
      allocatePullRequestGenerationRequestId,
      branchName,
      hostedReviewCreateProvider,
      refreshGitStatusAfterPullRequestGeneration,
      resolvedPrCreationDefaults.useTemplate,
      setPullRequestGenerationRecord,
      updatePullRequestGenerationRecord,
      worktreePath
    ]
  )

  const handleCancelGeneratePullRequestFieldsForActive = useCallback((): void => {
    if (!activePullRequestGenerationKey) {
      return
    }
    const record = prGenerationRecords[activePullRequestGenerationKey]
    if (!record || record.status !== 'running') {
      return
    }
    const generationKey = activePullRequestGenerationKey
    updatePullRequestGenerationRecord(generationKey, (current) => {
      if (!current || current.context.requestId !== record.context.requestId) {
        return null
      }
      return resolvePullRequestGenerationCancel(current)
    })
    void cancelRuntimeGeneratePullRequestFields({
      // Cancel on the original request owner even after host navigation.
      target: record.context.runtimeTarget,
      worktreeId: record.context.worktreeId,
      worktreePath: record.context.worktreePath,
      connectionId: record.context.connectionId
    }).catch((error) => {
      updatePullRequestGenerationRecord(generationKey, (current) => {
        if (!current || current.context.requestId !== record.context.requestId) {
          return null
        }
        return {
          ...current,
          status: 'failed',
          error: error instanceof Error ? error.message : 'Failed to stop pull request generation',
          hydrated: false
        }
      })
    })
  }, [activePullRequestGenerationKey, prGenerationRecords, updatePullRequestGenerationRecord])

  const handlePullRequestGenerationSeedRestored = useCallback((): void => {
    if (!activePullRequestGenerationKey || !activePullRequestGenerationRecord) {
      return
    }
    const requestId = activePullRequestGenerationRecord.context.requestId
    updatePullRequestGenerationRecord(activePullRequestGenerationKey, (record) =>
      markPullRequestGenerationTerminalSeedRestored({
        record,
        requestId
      })
    )
  }, [
    activePullRequestGenerationKey,
    activePullRequestGenerationRecord,
    updatePullRequestGenerationRecord
  ])

  return {
    activePullRequestGenerationKey,
    activePullRequestGenerationRecord,
    activePullRequestGenerationSeedRestoreKey,
    handleCancelGeneratePullRequestFieldsForActive,
    handleGeneratePullRequestFieldsForActive,
    handlePullRequestGenerationSeedRestored
  }
}

export type SourceControlPullRequestGeneration = ReturnType<
  typeof useSourceControlPullRequestGeneration
>
