import { useCallback } from 'react'
import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
import type { WorktreeCreationRequest } from '@/lib/workspace/creation/pending-worktree-creation'
import type { QuickSubmitOptions } from './quick-creation-request'
import { findPendingLinkedWorkItemCreationId } from '@/lib/workspace/creation/pending-worktree-creation'
import { useAppStore } from '@/store'
import { getWorkspaceSeedName } from '@/lib/workspace/creation/new-workspace'
import { settleComposerSubmit } from '@/lib/workspace/creation/composer-submit-cancellation'
import {
  formatWorkspaceCreateError,
  getWorkspaceCreateErrorToastMessage
} from '@/lib/workspace/creation/workspace-create-error-format'
import { toast } from 'sonner'
import { scheduleComposerCreateHandoff } from '@/lib/workspace/creation/composer-create-handoff'
import { assertBacklogLaunchTarget } from '@/lib/backlog-task-source'

import type { ComposerModel } from './composer-model'

type QuickSubmitActionInput = Pick<
  ComposerModel,
  | 'agentPrompt'
  | 'effectiveLinkedPR'
  | 'executeQuickCreation'
  | 'fallbackCreatureName'
  | 'isProjectGroupTarget'
  | 'isSubmissionCancelled'
  | 'linkedPR'
  | 'linkedWorkItem'
  | 'name'
  | 'onCreated'
  | 'parsedLinkedIssueNumber'
  | 'repoId'
  | 'requiresExplicitSetupChoice'
  | 'resolvePendingSmartGitHubSubmit'
  | 'selectedRepo'
  | 'selectedRepoRequiresConnection'
  | 'selectedTargetNeedsVisibleHost'
  | 'selectedWorkspaceTarget'
  | 'revealSetupChoice'
  | 'setCreateError'
  | 'setCreating'
  | 'setupDecision'
  | 'showProjectRequiredError'
  | 'sourceIntentBlocksCreate'
  | 'sparseError'
  | 'submitFolderTarget'
  | 'taskSourceContext'
  | 'telemetrySource'
>

/** Exposes guarded quick submission with pending-creation reuse and UI error/creating state settlement. */
export function useQuickSubmitAction(input: QuickSubmitActionInput) {
  const {
    agentPrompt,
    effectiveLinkedPR,
    executeQuickCreation,
    fallbackCreatureName,
    isProjectGroupTarget,
    isSubmissionCancelled,
    linkedPR,
    linkedWorkItem,
    name,
    onCreated,
    parsedLinkedIssueNumber,
    repoId,
    requiresExplicitSetupChoice,
    resolvePendingSmartGitHubSubmit,
    selectedRepo,
    selectedRepoRequiresConnection,
    selectedTargetNeedsVisibleHost,
    selectedWorkspaceTarget,
    revealSetupChoice,
    setCreateError,
    setCreating,
    setupDecision,
    showProjectRequiredError,
    sourceIntentBlocksCreate,
    sparseError,
    submitFolderTarget,
    taskSourceContext,
    telemetrySource
  } = input

  /** Rejects project-group Backlog launches and checks source/setup readiness before requesting creation. */
  const submitQuick = useCallback(
    async (requestedAgent: TuiAgent | null, options?: QuickSubmitOptions): Promise<void> => {
      if (isProjectGroupTarget && taskSourceContext?.provider === 'backlog') {
        setCreateError(
          formatWorkspaceCreateError(
            new Error('Select the Backlog task’s original project before launching.')
          )
        )
        return
      }
      if (isProjectGroupTarget) {
        await submitFolderTarget(requestedAgent, options)
        return
      }

      const workspaceNameSeed = getWorkspaceSeedName({
        explicitName: name,
        prompt: '',
        linkedIssueNumber: parsedLinkedIssueNumber,
        linkedPR,
        fallbackName: fallbackCreatureName
      })

      if (!repoId || !selectedRepo) {
        showProjectRequiredError()
        return
      }

      if (
        !workspaceNameSeed ||
        sourceIntentBlocksCreate ||
        selectedRepoRequiresConnection ||
        selectedTargetNeedsVisibleHost ||
        sparseError !== null
      ) {
        return
      }

      const workspaceRunContext: WorktreeCreationRequest['workspaceRunContext'] =
        selectedWorkspaceTarget.status === 'ready'
          ? {
              kind: 'workspace-run',
              projectId: selectedWorkspaceTarget.target.projectId,
              hostId: selectedWorkspaceTarget.target.hostId,
              projectHostSetupId: selectedWorkspaceTarget.target.projectHostSetupId,
              repoId: selectedWorkspaceTarget.target.repoId,
              path: selectedWorkspaceTarget.target.repo.path
            }
          : null

      const liveStore = useAppStore.getState()

      const pendingCreationId = findPendingLinkedWorkItemCreationId(
        liveStore.pendingWorktreeCreations,
        {
          repoId,
          ...(parsedLinkedIssueNumber != null ? { linkedIssue: parsedLinkedIssueNumber } : {}),
          ...(effectiveLinkedPR != null ? { linkedPR: effectiveLinkedPR } : {}),
          workspaceRunContext
        }
      )

      if (pendingCreationId) {
        liveStore.updatePendingWorktreeCreation(pendingCreationId, { loaderVisible: true })
        liveStore.setActivePendingWorktreeCreation(pendingCreationId)
        liveStore.setActiveView('terminal')
        liveStore.setSidebarOpen(true)
        onCreated?.()
        return
      }

      if (requiresExplicitSetupChoice && !setupDecision) {
        // The Run/Skip choice lives in Advanced; reveal it rather than refuse silently.
        revealSetupChoice()
        return
      }

      setCreateError(null)

      setCreating(true)
      const handoff = scheduleComposerCreateHandoff({
        stagingRequest: {
          repoId,
          workspaceRunContext,
          name: workspaceNameSeed,
          ...(parsedLinkedIssueNumber != null ? { linkedIssue: parsedLinkedIssueNumber } : {}),
          ...(effectiveLinkedPR != null ? { linkedPR: effectiveLinkedPR } : {}),
          setupDecision: setupDecision ?? 'inherit',
          agent: requestedAgent,
          pendingFirstAgentMessageRename: false,
          note: '',
          startupPlan: null,
          quickPrompt: '',
          quickTelemetry: null
        },
        // Why: closing (even under "Create more") keeps a later dismiss from cancelling this submit.
        onHandOff: () => onCreated?.(),
        isCancelled: isSubmissionCancelled,
        reopenComposer: () =>
          useAppStore.getState().openModal('new-workspace-composer', {
            prefilledName: name,
            initialRepoId: repoId,
            linkedWorkItem,
            taskSourceContext,
            // Why: the reopened modal seeds a Backlog draft only from this field.
            ...(taskSourceContext?.provider === 'backlog'
              ? { backlogTaskPrompt: agentPrompt }
              : {}),
            telemetrySource
          })
      })
      try {
        assertBacklogLaunchTarget(taskSourceContext, selectedRepo)
        const smartGitHubSettlement = await settleComposerSubmit(
          resolvePendingSmartGitHubSubmit(),
          isSubmissionCancelled
        )
        if (smartGitHubSettlement.status === 'cancelled') {
          return
        }
        await executeQuickCreation(
          smartGitHubSettlement.value,
          requestedAgent,
          workspaceNameSeed,
          workspaceRunContext,
          repoId,
          options,
          handoff
        )
      } catch (error) {
        if (isSubmissionCancelled()) {
          return
        }
        const formattedError = formatWorkspaceCreateError(error)
        if (handoff.fail(getWorkspaceCreateErrorToastMessage(formattedError))) {
          return
        }
        setCreateError(formattedError)
        toast.error(getWorkspaceCreateErrorToastMessage(formattedError))
      } finally {
        handoff.dispose()
        setCreating(false)
      }
    },
    [
      agentPrompt,
      effectiveLinkedPR,
      executeQuickCreation,
      fallbackCreatureName,
      isProjectGroupTarget,
      isSubmissionCancelled,
      linkedPR,
      linkedWorkItem,
      name,
      onCreated,
      parsedLinkedIssueNumber,
      repoId,
      requiresExplicitSetupChoice,
      resolvePendingSmartGitHubSubmit,
      selectedRepo,
      selectedRepoRequiresConnection,
      selectedTargetNeedsVisibleHost,
      selectedWorkspaceTarget,
      revealSetupChoice,
      setCreateError,
      setCreating,
      setupDecision,
      showProjectRequiredError,
      sourceIntentBlocksCreate,
      sparseError,
      submitFolderTarget,
      taskSourceContext,
      telemetrySource
    ]
  )

  return { submitQuick }
}
