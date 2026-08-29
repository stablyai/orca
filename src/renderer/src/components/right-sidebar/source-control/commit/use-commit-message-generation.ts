import { useCallback, useEffect } from 'react'
import { getConnectionId } from '@/lib/connection-context'
import {
  cancelRuntimeGenerateCommitMessage,
  generateRuntimeCommitMessage,
  type RuntimeGenerateCommitMessageOverrides
} from '@/runtime/runtime-git-client'
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

/**
 * Drives AI commit-message generation for the active worktree: start, cancel, and the store record
 * that lets a run which outlived an unmount hydrate the textarea exactly once on remount.
 */
export function useSourceControlCommitMessageGeneration({
  activeRepo,
  activeRepoSettings,
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
  activeRepoSettings: SourceControlWorktreeContext['activeRepoSettings']
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
      if (!activeWorktreeId || !worktreePath || !activeCommitMessageGenerationKey) {
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
          setGenerateErrors((prev) => ({
            ...prev,
            [activeWorktreeId]:
              'Custom command is empty. Add one in Settings -> Git -> Source Control AI.'
          }))
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
          runtimeTargetSettings: activeRepoSettings
        })
      )
      setGenerateInFlightByWorktree((prev) => ({ ...prev, [activeWorktreeId]: true }))
      setGenerateErrors((prev) => ({ ...prev, [activeWorktreeId]: null }))
      try {
        const result = await generateRuntimeCommitMessage(
          {
            // Why: route generation by the repo OWNER host, not the focused runtime.
            settings: activeRepoSettings,
            worktreeId: activeWorktreeId,
            worktreePath,
            connectionId
          },
          overrides
        )

        if (!result.success) {
          // Why: cancellation is a deliberate user action, not a failure to surface.
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

        updateCommitMessageGenerationRecord(activeCommitMessageGenerationKey, (record) =>
          resolveCommitMessageGenerationSuccess({
            record,
            requestId,
            message: result.message
          })
        )
        // Why: race protection — drop the generated message if the user typed into the textarea while the agent ran, rather than overwrite their edits.
        updateCommitDrafts((prev) => {
          const current = prev[activeWorktreeId]
          if (current && current.length > 0) {
            return prev
          }
          return writeCommitDraftForWorktree(prev, activeWorktreeId, result.message)
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
      activeRepoSettings,
      activeWorktreeId,
      allocateCommitMessageGenerationRequestId,
      generateInFlightRef,
      resolvedCommitMessageAi,
      setCommitMessageGenerationRecord,
      setGenerateErrors,
      setGenerateInFlightByWorktree,
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
    // Why: fire-and-forget; the in-flight promise resolves {canceled: true} where the spinner clears, so awaiting would just delay UI feedback.
    void cancelRuntimeGenerateCommitMessage({
      // Why: route the cancel by the repo OWNER host, not the focused runtime.
      settings: activeRepoSettings,
      worktreeId: activeWorktreeId,
      worktreePath,
      connectionId
    })
  }, [
    activeCommitMessageGenerationKey,
    activeRepoSettings,
    activeWorktreeId,
    generateInFlightRef,
    updateCommitMessageGenerationRecord,
    worktreePath
  ])

  useEffect(() => {
    // Why: generation can finish after Source Control unmounts; the store record lets the remounted textarea consume it once.
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
