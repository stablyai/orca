import type { ComposerModel } from './composer-model'

type QuickCreationExecutionInput = Pick<
  ComposerModel,
  | 'clearNewWorkspaceDraft'
  | 'createMultiple'
  | 'effectivePresetId'
  | 'ephemeralVmRecipes'
  | 'ephemeralVmsEnabled'
  | 'isSubmissionCancelled'
  | 'linkedGitLabIssue'
  | 'linkedGitLabMR'
  | 'normalizedSparseDirectories'
  | 'onCreated'
  | 'parentWorktreeId'
  | 'persistDraft'
  | 'persistSetupAgentStartupPolicy'
  | 'prepareQuickSubmit'
  | 'resetForNextCreate'
  | 'resolvedInitialWorkspaceStatus'
  | 'selectedEphemeralVmRecipeId'
  | 'selectedRepoAgentLaunchPlatform'
  | 'selectedRepoExecutionHostId'
  | 'selectedRepoIsGit'
  | 'selectedRepoIsRemote'
  | 'selectedRepoSettings'
  | 'selectedRepoStartupShell'
  | 'selectedWorkspaceTarget'
  | 'settings'
  | 'sparseEnabled'
  | 'taskSourceContext'
  | 'telemetrySource'
>

import { useCallback } from 'react'
import type { Repo } from '../../../../shared/repo-types'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { WorktreeCreationRequest } from '@/lib/pending-worktree-creation'
import { useAppStore } from '@/store'
import { settleComposerSubmit } from '@/lib/composer-submit-cancellation'
import { ensureHooksConfirmed } from '@/lib/ensure-hooks-confirmed'
import { getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'
import { runBackgroundWorktreeCreation } from '@/lib/worktree-creation-flow'
import { translate } from '@/i18n/i18n'
import { resolveQuickCreateLinkedWorkItemPrompt } from '@/lib/linked-work-item-context'
import { buildQuickComposerStartup } from './quick-startup-plan'
import { buildQuickCreationRequest } from './quick-creation-request'
import type { PendingSmartGitHubSubmitResolution } from './source-selection-decisions'
import {
  hasExplicitTuiLaunchCustomization,
  resolveAgentLaunchRoute
} from '@/lib/agent-launch-routing'
import { readLocalRuntimeCapabilities } from '@/runtime/local-runtime-capabilities'
import { CLIENT_PLATFORM } from '@/lib/new-workspace'

export function useQuickCreationExecution(input: QuickCreationExecutionInput) {
  const {
    clearNewWorkspaceDraft,
    createMultiple,
    effectivePresetId,
    ephemeralVmRecipes,
    ephemeralVmsEnabled,
    isSubmissionCancelled,
    linkedGitLabIssue,
    linkedGitLabMR,
    normalizedSparseDirectories,
    onCreated,
    parentWorktreeId,
    persistDraft,
    persistSetupAgentStartupPolicy,
    prepareQuickSubmit,
    resetForNextCreate,
    resolvedInitialWorkspaceStatus,
    selectedEphemeralVmRecipeId,
    selectedRepoAgentLaunchPlatform,
    selectedRepoExecutionHostId,
    selectedRepoIsGit,
    selectedRepoIsRemote,
    selectedRepoSettings,
    selectedRepoStartupShell,
    selectedWorkspaceTarget,
    settings,
    sparseEnabled,
    taskSourceContext,
    telemetrySource
  } = input

  const executeQuickCreation = useCallback(
    async (
      smartGitHubResolution: PendingSmartGitHubSubmitResolution,
      requestedAgent: TuiAgent | null,
      workspaceNameSeed: string,
      workspaceRunContext: WorktreeCreationRequest['workspaceRunContext'],
      repoId: string,
      selectedRepo: Repo
    ): Promise<void> => {
      const prepared = await prepareQuickSubmit(
        smartGitHubResolution,
        requestedAgent,
        workspaceNameSeed
      )

      if (!prepared) {
        return
      }

      const {
        submitLinkedWorkItem,
        agent,
        submitLinkedIssueNumber,
        submitLinkedPR,
        workspaceName,
        nameWasGenerated,
        nameIsAutoManaged,
        submitCompareBaseRef,
        submitPushTarget,
        effectiveSetupDecision,
        issueCommand,
        linkedLinearIssue,
        linkedLinearIssueWorkspaceId,
        linkedLinearIssueOrganizationUrlKey,
        effectiveBranchNameOverride,
        submitBaseBranch,
        createDisplayName,
        pendingFirstAgentMessageRename,
        trimmedNote
      } = prepared

      const promptLinkedWorkItem = agent === null ? null : submitLinkedWorkItem

      const { prompt: quickPrompt, draftPrompt: quickDraftPrompt } =
        resolveQuickCreateLinkedWorkItemPrompt(promptLinkedWorkItem, trimmedNote)

      const {
        startupPlan,
        backendStartup,
        telemetry: quickTelemetry
      } = buildQuickComposerStartup({
        agent,
        prompt: quickPrompt,
        draftPrompt: quickDraftPrompt,
        settings,
        repoConnectionId: selectedRepo.connectionId,
        platform: selectedRepoAgentLaunchPlatform,
        shell: selectedRepoStartupShell,
        isRemote: selectedRepoIsRemote,
        telemetrySource
      })

      const startupPolicySettlement = await settleComposerSubmit(
        persistSetupAgentStartupPolicy(),
        isSubmissionCancelled
      )

      if (startupPolicySettlement.status === 'cancelled') {
        return
      }

      if (!startupPolicySettlement.value) {
        throw new Error(
          translate(
            'auto.hooks.useComposerState.setupAgentStartupPolicySaveFailed',
            'Failed to save setup startup behavior.'
          )
        )
      }

      let ephemeralVmRecipe: WorktreeCreationRequest['ephemeralVmRecipe']

      const activeEphemeralVmRecipeId = ephemeralVmsEnabled ? selectedEphemeralVmRecipeId : null

      if (activeEphemeralVmRecipeId && selectedWorkspaceTarget.status === 'ready') {
        const vmRecipeTrustSettlement = await settleComposerSubmit(
          ensureHooksConfirmed(
            useAppStore.getState(),
            repoId,
            'vmRecipe',
            selectedRepoExecutionHostId ?? undefined,
            undefined,
            isSubmissionCancelled
          ),
          isSubmissionCancelled
        )
        if (vmRecipeTrustSettlement.status === 'cancelled') {
          return
        }
        const vmRecipeTrustDecision = vmRecipeTrustSettlement.value
        if (vmRecipeTrustDecision === 'skip') {
          return
        }
        const selectedRecipe = ephemeralVmRecipes.find(
          (recipe) => recipe.id === activeEphemeralVmRecipeId
        )
        ephemeralVmRecipe = {
          sourceRepoId: repoId,
          recipeId: activeEphemeralVmRecipeId,
          projectId: selectedWorkspaceTarget.target.projectId,
          ...(selectedRecipe?.checkoutMode ? { checkoutMode: selectedRecipe.checkoutMode } : {})
        }
      }

      const agentLaunchRoute = agent
        ? resolveAgentLaunchRoute({
            agent,
            settings,
            executionHostId: ephemeralVmRecipe
              ? 'runtime:pending-ephemeral-vm'
              : (workspaceRunContext?.hostId ?? selectedRepoExecutionHostId ?? 'local'),
            platform: CLIENT_PLATFORM,
            hostCapabilities: readLocalRuntimeCapabilities(),
            workspaceKind: selectedRepoIsGit ? 'git-worktree' : 'folder',
            promptDelivery: quickDraftPrompt ? 'draft' : 'auto-submit',
            launchText: quickDraftPrompt ?? quickPrompt,
            nativeChatTranscriptIsLocalReadable: !selectedRepoIsRemote,
            requiresTuiLaunchCustomization: hasExplicitTuiLaunchCustomization(settings, agent),
            initialSessionOptions: startupPlan?.sessionOptions
          })
        : 'terminal-tui'
      const structuredLaunch = agentLaunchRoute === 'structured-native-chat'

      const request = buildQuickCreationRequest({
        repoId,
        ephemeralVmRecipe,
        indeterminateProgress:
          Boolean(activeEphemeralVmRecipeId) ||
          getActiveRuntimeTarget(selectedRepoSettings).kind !== 'local',
        taskSourceContext,
        linkedWorkItem: submitLinkedWorkItem,
        workspaceRunContext,
        workspaceName,
        nameWasGenerated,
        displayName: createDisplayName,
        displayNameKind: createDisplayName ? (nameIsAutoManaged ? 'generated' : 'user') : undefined,
        selectedRepoIsGit,
        baseBranch: submitBaseBranch,
        compareBaseRef: submitCompareBaseRef,
        setupDecision: effectiveSetupDecision,
        sparseDirectories: selectedRepoIsGit && sparseEnabled ? normalizedSparseDirectories : null,
        sparsePresetId: effectivePresetId,
        telemetrySource,
        linkedIssue: submitLinkedIssueNumber,
        linkedPR: submitLinkedPR,
        pushTarget: submitPushTarget,
        agent,
        agentLaunchRoute,
        linkedLinearIssue,
        linkedLinearIssueWorkspaceId,
        linkedLinearIssueOrganizationUrlKey,
        branchNameOverride: effectiveBranchNameOverride,
        parentWorktreeId,
        workspaceStatus: resolvedInitialWorkspaceStatus,
        linkedGitLabMR,
        linkedGitLabIssue,
        includeGitLabLinks: smartGitHubResolution.kind === 'none',
        startup: structuredLaunch ? undefined : backendStartup,
        issueCommand,
        pendingFirstAgentMessageRename,
        note: trimmedNote,
        startupPlan,
        quickPrompt,
        launchDraftPrompt: quickDraftPrompt,
        quickTelemetry,
        suppressTerminalFocusOnCompletion: createMultiple
      })

      if (isSubmissionCancelled()) {
        return
      }

      if (persistDraft) {
        clearNewWorkspaceDraft()
      }

      runBackgroundWorktreeCreation(request)

      if (createMultiple) {
        resetForNextCreate()
      } else {
        onCreated?.()
      }
    },
    [
      clearNewWorkspaceDraft,
      createMultiple,
      effectivePresetId,
      ephemeralVmRecipes,
      ephemeralVmsEnabled,
      isSubmissionCancelled,
      linkedGitLabIssue,
      linkedGitLabMR,
      normalizedSparseDirectories,
      onCreated,
      parentWorktreeId,
      persistDraft,
      persistSetupAgentStartupPolicy,
      prepareQuickSubmit,
      resetForNextCreate,
      resolvedInitialWorkspaceStatus,
      selectedEphemeralVmRecipeId,
      selectedRepoAgentLaunchPlatform,
      selectedRepoExecutionHostId,
      selectedRepoIsGit,
      selectedRepoIsRemote,
      selectedRepoSettings,
      selectedRepoStartupShell,
      selectedWorkspaceTarget,
      settings,
      sparseEnabled,
      taskSourceContext,
      telemetrySource
    ]
  )

  return {
    executeQuickCreation
  }
}
