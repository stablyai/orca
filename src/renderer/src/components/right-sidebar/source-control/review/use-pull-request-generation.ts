import { useCallback } from 'react'
import { getConnectionId } from '@/lib/connection-context'
import {
  cancelRuntimeGeneratePullRequestFields,
  generateRuntimePullRequestFields,
  type RuntimeGeneratePullRequestFieldsOverrides
} from '@/runtime/runtime-git-client'
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
import type { HostedReviewProvider } from '../../../../../../shared/hosted-review'
import type { SourceControlAi } from '../ai/use-ai'
import { stripBaseRef } from '../../create-pull-request-base-ref-normalization'
import type { SourceControlStoreActions } from '../listing/use-store-actions'
import type { SourceControlWorktreeContext } from '../listing/use-worktree-context'
import type { SourceControlStatusRefresh } from '../sync/use-status-refresh'

/**
 * Runs AI generation of the PR title/body/base for the active branch through a store record, so a
 * run started before a tab switch is still resumable when the composer remounts.
 */
export function useSourceControlPullRequestGeneration({
  activeRepo,
  activeRepoSettings,
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
  activeRepoSettings: SourceControlWorktreeContext['activeRepoSettings']
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
      overrides?: RuntimeGeneratePullRequestFieldsOverrides
    ): Promise<void> => {
      if (!activeRepo || !activePullRequestGenerationKey || !worktreePath || !branchName) {
        return
      }
      const generationKey = activePullRequestGenerationKey
      if (
        useAppStore.getState().pullRequestGenerationRecords[generationKey]?.status === 'running'
      ) {
        return
      }
      const requestId = allocatePullRequestGenerationRequestId()
      const context: PullRequestGenerationContext = {
        worktreeId: activeWorktreeId,
        worktreePath,
        connectionId: getConnectionId(activeWorktreeId) ?? undefined,
        requestId,
        repoId: activeRepo.id,
        branch: branchName,
        runtimeTargetSettings: activeRepoSettings
      }
      const seed = { ...fields }
      // Why: SourceControl can unmount on tab switches; the persisted record lets the PR composer resume on return.
      setPullRequestGenerationRecord(
        generationKey,
        createRunningPullRequestGenerationRecord(context, seed, fieldRevisions)
      )

      try {
        const result = await generateRuntimePullRequestFields(
          {
            // Why: route generation by the repo OWNER host, not the focused runtime.
            settings: context.runtimeTargetSettings,
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
    },
    [
      activePullRequestGenerationKey,
      activeRepo,
      activeRepoSettings,
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
      // Why: the user can switch hosts while generation runs; cancel the original request owner, not the focused host.
      settings: record.context.runtimeTargetSettings,
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
