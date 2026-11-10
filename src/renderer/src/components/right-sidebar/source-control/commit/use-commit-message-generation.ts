import {
  useSourceControlStoreView,
  useSourceControlState,
  sourceControlConnectionId,
  useSourceControlScope
} from '../panel/worktree-scope'
import { resolveSourceControlAiEnabled } from '../../../../../../shared/source-control/ai/source-control-ai-operation-policy'
import { resolveSourceControlAiForOperation } from '../../../../../../shared/source-control/ai/source-control-ai-operation-resolution'
import { getRuntimeGitRepoDiscoveryHostKey } from '@/runtime/source-control/git/runtime-git-client-context'
import { textGenerationCopyText } from '@/lib/text-generation-error-copy'
import { useCallback, useEffect } from 'react'
import { useStore } from 'zustand'
import {
  cancelRuntimeGenerateCommitMessage,
  generateRuntimeCommitMessage
} from '@/runtime/source-control/git/runtime-git-generation-client'
import type { RuntimeGenerateCommitMessageOverrides } from '@/runtime/source-control/git/runtime-git-client-context'
import { useAppStore } from '@/store'
import {
  createRunningCommitMessageGenerationRecord,
  getCommitMessageGenerationRecordKey,
  markCommitMessageGenerationHydrated,
  resolveCommitMessageGenerationCancel,
  resolveCommitMessageGenerationFailure,
  resolveCommitMessageGenerationSuccess,
  type CommitMessageGenerationRecord
} from '@/store/slices/hosted-review/generation/commit-message-generation'
import { isCustomAgentId } from '../../../../../../shared/source-control/ai/generation/commit-message-agent-spec'
import { hasConfiguredCommitMessageGenerationDefaults } from '../ai/text-generation-defaults'
import type { SourceControlAi } from '../ai/use-ai'
import type { SourceControlStoreActions } from '../listing/use-store-actions'
import type { SourceControlWorktreeContext } from '../listing/use-worktree-context'
import type { SourceControlWorktreeOperationState } from '../panel/use-worktree-operation-state'

/** Persist generation records so results completed after unmount hydrate the textarea once on return. */
export function useSourceControlCommitMessageGeneration({
  activeRepo,
  activeRepoTarget,
  activeWorktreeId,
  allocateCommitMessageGenerationRequestId,
  openCommitGenerationDialog,
  operationStore,
  setCommitMessageGenerationRecord,
  updateCommitDraft,
  updateCommitMessageGenerationRecord,
  worktreePath
}: {
  activeRepo: SourceControlWorktreeContext['activeRepo']
  activeRepoTarget: SourceControlWorktreeContext['activeRepoTarget']
  activeWorktreeId: string | null
  allocateCommitMessageGenerationRequestId: SourceControlStoreActions['allocateCommitMessageGenerationRequestId']
  openCommitGenerationDialog: SourceControlAi['openCommitGenerationDialog']
  operationStore: SourceControlWorktreeOperationState['operationStore']
  setCommitMessageGenerationRecord: SourceControlStoreActions['setCommitMessageGenerationRecord']
  updateCommitDraft: SourceControlWorktreeOperationState['updateCommitDraft']
  updateCommitMessageGenerationRecord: SourceControlStoreActions['updateCommitMessageGenerationRecord']
  worktreePath: string | null
}) {
  const scope = useSourceControlScope()
  const activeCommitMessageGenerationKey = getCommitMessageGenerationRecordKey(
    activeWorktreeId,
    worktreePath
  )
  // Select only this owner's record so another worktree's generation cannot re-render this panel.
  const activeCommitMessageGenerationRecord: CommitMessageGenerationRecord | null =
    useSourceControlState((s) =>
      activeCommitMessageGenerationKey
        ? (s.commitMessageGenerationRecords[activeCommitMessageGenerationKey] ?? null)
        : null
    )
  const operationView = useSourceControlStoreView(operationStore)
  const generateInFlight = useStore(operationView, (s) => s.generateInFlight)
  const ownerGenerateError = useStore(operationView, (s) => s.generateError)
  const isGenerating = activeCommitMessageGenerationRecord?.status === 'running' || generateInFlight
  const generateError = activeCommitMessageGenerationRecord?.error ?? ownerGenerateError

  const resolveCurrentAi = useCallback(() => {
    const settings = useAppStore.getState().settings
    return settings
      ? resolveSourceControlAiForOperation({
          settings,
          repo: activeRepo,
          operation: 'commitMessage',
          discoveryHostKey: getRuntimeGitRepoDiscoveryHostKey(
            activeRepoTarget ?? { kind: 'local' },
            activeRepo,
            sourceControlConnectionId(scope, activeWorktreeId)
          )
        })
      : null
  }, [activeRepo, activeRepoTarget, activeWorktreeId, scope])

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
      if (operationStore.getState().generateInFlight) {
        return
      }
      const resolvedCommitMessageAi = resolveCurrentAi()
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
          operationStore.setState({ generateError: message })
          return
        }
      }

      operationStore.setState({ generateInFlight: true, generateError: null })
      const requestId = allocateCommitMessageGenerationRequestId()
      const connectionId = sourceControlConnectionId(scope, activeWorktreeId)
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
      try {
        const result = await generateRuntimeCommitMessage(
          {
            // Route generation through workspace ownership rather than focused runtime.
            target: activeRepoTarget,
            prefs: useAppStore.getState().settings,
            worktreeId: activeWorktreeId,
            worktreePath,
            connectionId
          },
          overrides
        )

        if (!result.success) {
          // Cancellation is an intentional action and must not surface as failure.
          if (result.canceled) {
            operationStore.setState({ generateError: null })
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
          operationStore.setState({ generateError: result.error })
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
        updateCommitDraft((current) =>
          !succeeded || current.length > 0 ? current : result.message
        )
        useAppStore.getState().recordFeatureInteraction('ai-commit-generation')
        operationStore.setState({ generateError: null })
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to generate commit message'
        operationStore.setState({ generateError: message })
        updateCommitMessageGenerationRecord(activeCommitMessageGenerationKey, (record) =>
          resolveCommitMessageGenerationFailure({
            record,
            requestId,
            error: message
          })
        )
      } finally {
        operationStore.setState({ generateInFlight: false })
      }
    },
    [
      scope,
      activeCommitMessageGenerationKey,
      activeRepoTarget,
      activeWorktreeId,
      allocateCommitMessageGenerationRequestId,
      operationStore,
      resolveCurrentAi,
      setCommitMessageGenerationRecord,
      updateCommitDraft,
      updateCommitMessageGenerationRecord,
      worktreePath
    ]
  )

  const handleGenerateCommitMessageClick = useCallback((): void => {
    const settings = useAppStore.getState().settings
    const resolvedCommitMessageAi = resolveCurrentAi()
    if (!settings || !resolveSourceControlAiEnabled({ settings, repo: activeRepo })) {
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
  }, [activeRepo, handleGenerate, openCommitGenerationDialog, resolveCurrentAi])

  const handleCancelGenerate = useCallback((): void => {
    if (!activeWorktreeId || !worktreePath || !activeCommitMessageGenerationKey) {
      return
    }
    if (!operationStore.getState().generateInFlight) {
      return
    }
    updateCommitMessageGenerationRecord(activeCommitMessageGenerationKey, (record) =>
      resolveCommitMessageGenerationCancel(record)
    )
    const connectionId = sourceControlConnectionId(scope, activeWorktreeId)
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
    operationStore,
    scope,
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
    updateCommitDraft((current) =>
      current.length > 0 ? current : (activeCommitMessageGenerationRecord.message ?? '')
    )
    updateCommitMessageGenerationRecord(activeCommitMessageGenerationKey, (record) =>
      markCommitMessageGenerationHydrated(record)
    )
  }, [
    activeCommitMessageGenerationKey,
    activeCommitMessageGenerationRecord,
    activeWorktreeId,
    updateCommitDraft,
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
