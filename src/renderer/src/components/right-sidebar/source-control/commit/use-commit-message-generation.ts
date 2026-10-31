import { textGenerationCopyText } from '@/lib/text-generation-error-copy'
import { useCallback, useEffect } from 'react'
import { getConnectionId } from '@/lib/connection-context'
import {
  cancelRuntimeGenerateCommitMessage,
  generateRuntimeCommitMessage
} from '@/runtime/runtime-git-generation-client'
import type { RuntimeGenerateCommitMessageOverrides } from '@/runtime/runtime-git-client-context'
import { useAppStore } from '@/store'
import {
  createRunningCommitMessageGenerationRecord,
  getCommitMessageGenerationRecordKey,
  markCommitMessageGenerationHydrated,
  resolveCommitMessageGenerationCancel,
  resolveCommitMessageGenerationFailure,
  resolveCommitMessageGenerationSuccess,
  type CommitMessageGenerationRecord
} from '@/store/slices/commit-message-generation'
import { isCustomAgentId } from '../../../../../../shared/commit-message-agent-spec'
import { hasConfiguredCommitMessageGenerationDefaults } from '../ai/text-generation-defaults'
import type { SourceControlAi } from '../ai/use-ai'
import type { SourceControlStoreActions } from '../listing/use-store-actions'
import type { SourceControlWorktreeContext } from '../listing/use-worktree-context'
import type { SourceControlWorktreeOperationState } from '../panel/use-worktree-operation-state'
import { writeCommitDraftForWorktree } from './commit-drafts'

/** Persist generation records so results completed after unmount hydrate the textarea once on return. */
export function useSourceControlCommitMessageGeneration({
  activeRepo,
  activeRepoTarget,
  activeWorktreeId,
  allocateCommitMessageGenerationRequestId,
  commitMessageGenerationRecords,
  generateErrors,
  generateInFlightByWorktree,
  generateInFlightRef,
  openCommitGenerationDialog,
  resolvedCommitMessageAi,
  setCommitMessageGenerationRecord,
  setGenerateErrors,
  setGenerateInFlightByWorktree,
  settings,
  sourceControlAiActionsVisible,
  updateCommitDrafts,
  updateCommitMessageGenerationRecord,
  worktreePath
}: {
  activeRepo: SourceControlWorktreeContext['activeRepo']
  activeRepoTarget: SourceControlWorktreeContext['activeRepoTarget']
  activeWorktreeId: string | null
  allocateCommitMessageGenerationRequestId: SourceControlStoreActions['allocateCommitMessageGenerationRequestId']
  commitMessageGenerationRecords: SourceControlStoreActions['commitMessageGenerationRecords']
  generateErrors: SourceControlWorktreeOperationState['generateErrors']
  generateInFlightByWorktree: SourceControlWorktreeOperationState['generateInFlightByWorktree']
  generateInFlightRef: SourceControlWorktreeOperationState['generateInFlightRef']
  openCommitGenerationDialog: SourceControlAi['openCommitGenerationDialog']
  resolvedCommitMessageAi: SourceControlAi['resolvedCommitMessageAi']
  setCommitMessageGenerationRecord: SourceControlStoreActions['setCommitMessageGenerationRecord']
  setGenerateErrors: SourceControlWorktreeOperationState['setGenerateErrors']
  setGenerateInFlightByWorktree: SourceControlWorktreeOperationState['setGenerateInFlightByWorktree']
  settings: SourceControlWorktreeContext['settings']
  sourceControlAiActionsVisible: boolean
  updateCommitDrafts: SourceControlWorktreeOperationState['updateCommitDrafts']
  updateCommitMessageGenerationRecord: SourceControlStoreActions['updateCommitMessageGenerationRecord']
  worktreePath: string | null
}) {
  const activeCommitMessageGenerationKey = getCommitMessageGenerationRecordKey(
    activeWorktreeId,
    worktreePath
  )
  const activeCommitMessageGenerationRecord: CommitMessageGenerationRecord | null =
    activeCommitMessageGenerationKey
      ? (commitMessageGenerationRecords[activeCommitMessageGenerationKey] ?? null)
      : null
  const isGenerating =
    activeCommitMessageGenerationRecord?.status === 'running' ||
    (generateInFlightByWorktree[activeWorktreeId ?? ''] ?? false)
  const generateError =
    activeCommitMessageGenerationRecord?.error ?? generateErrors[activeWorktreeId ?? ''] ?? null

  const handleGenerate = useCallback(
    async (overrides?: RuntimeGenerateCommitMessageOverrides): Promise<void> => {
      if (
        !activeWorktreeId ||
        !worktreePath ||
        !activeCommitMessageGenerationKey ||
        !activeRepoTarget
      ) {
        return
      }
      if (generateInFlightRef.current[activeWorktreeId]) {
        return
      }
      if (!overrides?.sourceControlAiResolvedParams && resolvedCommitMessageAi?.ok !== true) {
        return
      }

      if (
        !overrides?.sourceControlAiResolvedParams &&
        resolvedCommitMessageAi?.ok === true &&
        isCustomAgentId(resolvedCommitMessageAi.value.params.agentId)
      ) {
        const command = resolvedCommitMessageAi.value.params.customAgentCommand?.trim() ?? ''
        if (!command) {
          const message = textGenerationCopyText('sourceControlCustomCommandEmpty')
          setGenerateErrors((prev) => ({ ...prev, [activeWorktreeId]: message }))
          return
        }
      }

      generateInFlightRef.current[activeWorktreeId] = true
      const requestId = allocateCommitMessageGenerationRequestId()
      const connectionId = getConnectionId(activeWorktreeId) ?? undefined
      setCommitMessageGenerationRecord(
        activeCommitMessageGenerationKey,
        createRunningCommitMessageGenerationRecord({
          worktreeId: activeWorktreeId,
          worktreePath,
          connectionId,
          requestId,
          runtimeTarget: activeRepoTarget
        })
      )
      setGenerateInFlightByWorktree((prev) => ({ ...prev, [activeWorktreeId]: true }))
      setGenerateErrors((prev) => ({ ...prev, [activeWorktreeId]: null }))
      try {
        const result = await generateRuntimeCommitMessage(
          {
            // Route generation through workspace ownership rather than focused runtime.
            target: activeRepoTarget,
            prefs: settings,
            worktreeId: activeWorktreeId,
            worktreePath,
            connectionId
          },
          overrides
        )

        if (!result.success) {
          // Cancellation is an intentional action and must not surface as failure.
          if (result.canceled) {
            setGenerateErrors((prev) => ({ ...prev, [activeWorktreeId]: null }))
            updateCommitMessageGenerationRecord(activeCommitMessageGenerationKey, (record) =>
              resolveCommitMessageGenerationFailure({
                record,
                requestId,
                canceled: true,
                error: null
              })
            )
            return
          }
          setGenerateErrors((prev) => ({
            ...prev,
            [activeWorktreeId]: result.error
          }))
          updateCommitMessageGenerationRecord(activeCommitMessageGenerationKey, (record) =>
            resolveCommitMessageGenerationFailure({
              record,
              requestId,
              error: result.error
            })
          )
          return
        }

        const succeeded = resolveCommitMessageGenerationSuccess({
          record:
            useAppStore.getState().commitMessageGenerationRecords[activeCommitMessageGenerationKey],
          requestId,
          message: result.message
        })
        if (succeeded) {
          setCommitMessageGenerationRecord(activeCommitMessageGenerationKey, succeeded)
        }
        // Preserve typed edits and drop cancelled runs even if the host succeeds; their message may describe obsolete changes.
        updateCommitDrafts((prev) => {
          const current = prev[activeWorktreeId]
          return !succeeded || (current && current.length > 0)
            ? prev
            : writeCommitDraftForWorktree(prev, activeWorktreeId, result.message)
        })
        useAppStore.getState().recordFeatureInteraction('ai-commit-generation')
        setGenerateErrors((prev) => ({ ...prev, [activeWorktreeId]: null }))
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to generate commit message'
        setGenerateErrors((prev) => ({
          ...prev,
          [activeWorktreeId]: message
        }))
        updateCommitMessageGenerationRecord(activeCommitMessageGenerationKey, (record) =>
          resolveCommitMessageGenerationFailure({
            record,
            requestId,
            error: message
          })
        )
      } finally {
        setGenerateInFlightByWorktree((prev) => ({ ...prev, [activeWorktreeId]: false }))
        generateInFlightRef.current[activeWorktreeId] = false
      }
    },
    [
      activeCommitMessageGenerationKey,
      activeRepoTarget,
      activeWorktreeId,
      allocateCommitMessageGenerationRequestId,
      generateInFlightRef,
      resolvedCommitMessageAi,
      setCommitMessageGenerationRecord,
      setGenerateErrors,
      setGenerateInFlightByWorktree,
      settings,
      updateCommitDrafts,
      updateCommitMessageGenerationRecord,
      worktreePath
    ]
  )

  const handleGenerateCommitMessageClick = useCallback((): void => {
    if (!sourceControlAiActionsVisible) {
      return
    }
    if (
      hasConfiguredCommitMessageGenerationDefaults({ settings, repo: activeRepo ?? null }) &&
      resolvedCommitMessageAi?.ok
    ) {
      void handleGenerate({ sourceControlAiResolvedParams: resolvedCommitMessageAi.value.params })
      return
    }
    openCommitGenerationDialog()
  }, [
    activeRepo,
    handleGenerate,
    openCommitGenerationDialog,
    resolvedCommitMessageAi,
    settings,
    sourceControlAiActionsVisible
  ])

  const handleCancelGenerate = useCallback((): void => {
    if (!activeWorktreeId || !worktreePath || !activeCommitMessageGenerationKey) {
      return
    }
    if (!generateInFlightRef.current[activeWorktreeId]) {
      return
    }
    updateCommitMessageGenerationRecord(activeCommitMessageGenerationKey, (record) =>
      resolveCommitMessageGenerationCancel(record)
    )
    const connectionId = getConnectionId(activeWorktreeId) ?? undefined
    if (!activeRepoTarget) {
      return
    }
    // Do not await cancellation; the running promise clears the spinner when it reports cancelled.
    void cancelRuntimeGenerateCommitMessage({
      // Cancel through the workspace owner rather than focused runtime.
      target: activeRepoTarget,
      worktreeId: activeWorktreeId,
      worktreePath,
      connectionId
    })
  }, [
    activeCommitMessageGenerationKey,
    activeRepoTarget,
    activeWorktreeId,
    generateInFlightRef,
    updateCommitMessageGenerationRecord,
    worktreePath
  ])

  useEffect(() => {
    // Consume stored results once after generation completes across Source Control unmounts.
    if (
      !activeCommitMessageGenerationKey ||
      !activeWorktreeId ||
      !activeCommitMessageGenerationRecord ||
      activeCommitMessageGenerationRecord.status !== 'succeeded' ||
      !activeCommitMessageGenerationRecord.message ||
      activeCommitMessageGenerationRecord.hydrated
    ) {
      return
    }
    updateCommitDrafts((prev) => {
      const current = prev[activeWorktreeId]
      return current && current.length > 0
        ? prev
        : writeCommitDraftForWorktree(
            prev,
            activeWorktreeId,
            activeCommitMessageGenerationRecord.message ?? ''
          )
    })
    updateCommitMessageGenerationRecord(activeCommitMessageGenerationKey, (record) =>
      markCommitMessageGenerationHydrated(record)
    )
  }, [
    activeCommitMessageGenerationKey,
    activeCommitMessageGenerationRecord,
    activeWorktreeId,
    updateCommitDrafts,
    updateCommitMessageGenerationRecord
  ])

  return {
    generateError,
    handleCancelGenerate,
    handleGenerate,
    handleGenerateCommitMessageClick,
    isGenerating
  }
}

export type SourceControlCommitMessageGeneration = ReturnType<
  typeof useSourceControlCommitMessageGeneration
>
