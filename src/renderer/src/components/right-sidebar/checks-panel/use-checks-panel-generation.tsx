import { useCallback } from 'react'
import { useAppStore } from '@/store'
import { getConnectionId } from '@/lib/connection-context'
import {
  generateRuntimePullRequestFields,
  cancelRuntimeGeneratePullRequestFields,
  type RuntimeGeneratePullRequestFieldsOverrides
} from '@/runtime/runtime-git-client'
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
    | 'ownerSettings'
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
    ownerSettings,
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
      overrides?: RuntimeGeneratePullRequestFieldsOverrides
    ): Promise<void> => {
      if (!repo || !activePullRequestGenerationKey || !activeWorktreePath || !branch) {
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
        worktreePath: activeWorktreePath,
        connectionId: getConnectionId(activeWorktreeId) ?? undefined,
        requestId,
        repoId: repo.id,
        branch,
        runtimeTargetSettings: ownerSettings
      }
      const seed = { ...fields }
      const previousRequiresPushBeforeCreate =
        useAppStore.getState().pullRequestGenerationRecords[generationKey]
          ?.requiresPushBeforeCreate === true
      // Why: ChecksPanel unsets the composer on navigate-away; persist the request so generation can finish in the background.
      const runningRecord = createRunningPullRequestGenerationRecord(context, seed, fieldRevisions)
      setPullRequestGenerationRecord(
        generationKey,
        previousRequiresPushBeforeCreate
          ? { ...runningRecord, requiresPushBeforeCreate: true }
          : runningRecord
      )

      try {
        const result = await generateRuntimePullRequestFields(
          {
            // Why: route generation by the worktree owner captured at click time.
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
    },
    [
      activePullRequestGenerationKey,
      activeWorktreeId,
      activeWorktreePath,
      allocatePullRequestGenerationRequestId,
      branch,
      handleBranchChangedByPullRequestGeneration,
      hostedReviewCreateProvider,
      ownerSettings,
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
      // Why: Stop must target the request owner, not the currently focused worktree.
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
    handleGeneratePullRequestFieldsForActive,
    handleCancelGeneratePullRequestFieldsForActive,
    handlePullRequestGenerationSeedRestored
  }
}

export type ChecksPanelGenerationState = ReturnType<typeof useChecksPanelGeneration>
