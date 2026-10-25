import { getRepoExecutionHostId } from '../../../../../shared/execution-host'
import { getWorkspaceJiraIssueKey } from '../../../../../shared/jira/jira-review-title'
import { useCallback } from 'react'
import type { PullRequestGenerationOutcome } from '../create-pull-request-dialog-field-model'
import { settlePullRequestGenerationRequest } from '../pull-request-generation-request-outcome'
import { useAppStore } from '@/store'
import { getConnectionId } from '@/lib/connection-context'
import {
  generateRuntimePullRequestFields,
  cancelRuntimeGeneratePullRequestFields
} from '@/runtime/runtime-git-generation-client'
import type { RuntimeGeneratePullRequestFieldsOverrides } from '@/runtime/runtime-git-client-context'
import type { ChecksPanelReviewState } from './use-checks-panel-review-state'
import type { ChecksPanelControllerState } from './use-checks-panel-controller-state'
import { stripBaseRef } from '../create-pull-request-base-ref-normalization'
import {
  createRunningPullRequestGenerationRecord,
  markPullRequestGenerationTerminalSeedRestored,
  resolvePullRequestGenerationCancel,
  resolvePullRequestGenerationFailure,
  resolvePullRequestGenerationSuccess,
  type PullRequestFieldRevisions,
  type PullRequestGenerationContext,
  type PullRequestGenerationFields
} from '@/store/slices/pull-request-generation'
import type { PullRequestGenerationOptions } from '@/store/slices/pull-request-generation-auto-submit'

type ChecksPanelGenerationInput = Pick<
  ChecksPanelReviewState,
  | 'activePullRequestGenerationKey'
  | 'activePullRequestGenerationRecord'
  | 'handleBranchChangedByPullRequestGeneration'
  | 'hostedReviewCreateProvider'
  | 'prCreationDefaults'
> &
  Pick<
    ChecksPanelControllerState,
    | 'activeWorktreeId'
    | 'activeWorktreePath'
    | 'allocatePullRequestGenerationRequestId'
    | 'branch'
    | 'ownerTarget'
    | 'prGenerationRecords'
    | 'repo'
    | 'setPullRequestGenerationRecord'
    | 'updatePullRequestGenerationRecord'
  >

export function useChecksPanelGeneration(model: ChecksPanelGenerationInput) {
  const {
    activePullRequestGenerationKey,
    activePullRequestGenerationRecord,
    activeWorktreeId,
    activeWorktreePath,
    allocatePullRequestGenerationRequestId,
    branch,
    handleBranchChangedByPullRequestGeneration,
    hostedReviewCreateProvider,
    ownerTarget,
    prCreationDefaults,
    prGenerationRecords,
    repo,
    setPullRequestGenerationRecord,
    updatePullRequestGenerationRecord
  } = model
  const handleGeneratePullRequestFieldsForActive = useCallback(
    async (
      fields: PullRequestGenerationFields,
      fieldRevisions: PullRequestFieldRevisions,
      overrides?: RuntimeGeneratePullRequestFieldsOverrides,
      options?: PullRequestGenerationOptions
    ): Promise<PullRequestGenerationOutcome | undefined> => {
      if (
        !repo ||
        !activePullRequestGenerationKey ||
        !activeWorktreePath ||
        !branch ||
        !ownerTarget
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
      const context: PullRequestGenerationContext = {
        worktreeId: activeWorktreeId,
        worktreePath: activeWorktreePath,
        connectionId: getConnectionId(activeWorktreeId) ?? undefined,
        jiraIssueKey:
          (hostedReviewCreateProvider === 'github' || hostedReviewCreateProvider === 'gitlab') &&
          activeWorktreeId
            ? getWorkspaceJiraIssueKey(
                useAppStore
                  .getState()
                  .getKnownWorktreeById(activeWorktreeId, getRepoExecutionHostId(repo))
              )
            : null,
        requestId,
        repoId: repo.id,
        branch,
        runtimeTarget: ownerTarget
      }
      const seed = { ...fields }
      const previousRequiresPushBeforeCreate =
        useAppStore.getState().pullRequestGenerationRecords[generationKey]
          ?.requiresPushBeforeCreate === true
      // Persist generation through navigate-away, which unmounts the composer.
      const runningRecord = createRunningPullRequestGenerationRecord(
        context,
        seed,
        fieldRevisions,
        options?.autoSubmit
      )
      setPullRequestGenerationRecord(
        generationKey,
        previousRequiresPushBeforeCreate
          ? { ...runningRecord, requiresPushBeforeCreate: true }
          : runningRecord
      )

      const request = (async (): Promise<void> => {
        try {
          const result = await generateRuntimePullRequestFields(
            {
              // Route by the workspace owner captured at click time.
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
              useTemplate: prCreationDefaults.useTemplate
            },
            overrides
          )
          if (result.branchChangedByPreparation) {
            await handleBranchChangedByPullRequestGeneration(generationKey, context)
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
      activeWorktreeId,
      activeWorktreePath,
      allocatePullRequestGenerationRequestId,
      branch,
      handleBranchChangedByPullRequestGeneration,
      hostedReviewCreateProvider,
      ownerTarget,
      prCreationDefaults.useTemplate,
      repo,
      setPullRequestGenerationRecord,
      updatePullRequestGenerationRecord
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
      // Cancel on the request owner even if focus moved to another worktree.
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
    handleGeneratePullRequestFieldsForActive,
    handleCancelGeneratePullRequestFieldsForActive,
    handlePullRequestGenerationSeedRestored
  }
}

export type ChecksPanelGenerationState = ReturnType<typeof useChecksPanelGeneration>
