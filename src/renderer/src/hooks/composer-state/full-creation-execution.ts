import type { ComposerModel } from './composer-model'

export type FullCreationExecutionInput = Pick<
  ComposerModel,
  | 'applyWorktreeMeta'
  | 'clearNewWorkspaceDraft'
  | 'createWorktree'
  | 'effectivePresetId'
  | 'isSubmissionCancelled'
  | 'linkedGitLabIssue'
  | 'linkedGitLabMR'
  | 'normalizedSparseDirectories'
  | 'note'
  | 'onCreated'
  | 'parentWorktreeId'
  | 'persistDraft'
  | 'persistSetupAgentStartupPolicy'
  | 'prepareFullSubmit'
  | 'resolvedInitialWorkspaceStatus'
  | 'selectedRepoIsGit'
  | 'setSidebarOpen'
  | 'sparseEnabled'
  | 'taskSourceContext'
  | 'telemetrySource'
  | 'tuiAgent'
>

import { useCallback } from 'react'
import type { PendingSmartGitHubSubmitResolution } from './source-selection-decisions'
import { translate } from '@/i18n/i18n'
import { settleComposerSubmit } from '@/lib/composer-submit-cancellation'
import { toFolderWorkspaceLinkedTask } from '@/components/sidebar/folder-workspace-composer-helpers'
import { renderIssueCommandTemplate, ensureAgentStartupInTerminal } from '@/lib/new-workspace'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { seedNativeChatAppliedSessionOptions } from '@/components/native-chat/native-chat-session-option-cache'
import { queueWorkspaceActivationTerminalFocus } from '@/lib/workspace-activation-terminal-focus'

export function useFullCreationExecution(input: FullCreationExecutionInput) {
  const {
    applyWorktreeMeta,
    clearNewWorkspaceDraft,
    createWorktree,
    effectivePresetId,
    isSubmissionCancelled,
    linkedGitLabIssue,
    linkedGitLabMR,
    normalizedSparseDirectories,
    note,
    onCreated,
    parentWorktreeId,
    persistDraft,
    persistSetupAgentStartupPolicy,
    prepareFullSubmit,
    resolvedInitialWorkspaceStatus,
    selectedRepoIsGit,
    setSidebarOpen,
    sparseEnabled,
    taskSourceContext,
    telemetrySource,
    tuiAgent
  } = input

  const executeFullCreation = useCallback(
    async (
      smartGitHubResolution: PendingSmartGitHubSubmitResolution,
      repoId: string
    ): Promise<void> => {
      const prepared = await prepareFullSubmit(smartGitHubResolution)

      if (!prepared) {
        return
      }

      const {
        submitLinkedWorkItem,
        submitLinkedIssueNumber,
        submitLinkedPR,
        workspaceName,
        nameWasGenerated,
        submitBaseBranch,
        submitCompareBaseRef,
        submitPushTarget,
        submitStartupPrompt,
        submitShouldRunIssueAutomation,
        effectiveSetupDecision,
        issueCommandTrustDecision,
        confirmedIssueCommandTemplate,
        linkedLinearIssue,
        linkedLinearIssueWorkspaceId,
        linkedLinearIssueOrganizationUrlKey,
        effectiveBranchNameOverride,
        createDisplayName,
        pendingFirstAgentMessageRename,
        startupPlan,
        shouldSeedInitialAgentStatus,
        composerTelemetry,
        backendStartup
      } = prepared

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

      if (isSubmissionCancelled()) {
        return
      }

      const result = await createWorktree(
        repoId,
        workspaceName,
        selectedRepoIsGit ? submitBaseBranch : undefined,
        effectiveSetupDecision,
        selectedRepoIsGit && sparseEnabled
          ? {
              directories: normalizedSparseDirectories,
              ...(effectivePresetId ? { presetId: effectivePresetId } : {})
            }
          : undefined,
        telemetrySource,
        createDisplayName,
        submitLinkedIssueNumber ?? undefined,
        submitLinkedPR ?? undefined,
        submitPushTarget,
        tuiAgent,
        linkedLinearIssue,
        effectiveBranchNameOverride,
        resolvedInitialWorkspaceStatus,
        smartGitHubResolution.kind === 'none' ? (linkedGitLabMR ?? undefined) : undefined,
        smartGitHubResolution.kind === 'none' ? (linkedGitLabIssue ?? undefined) : undefined,
        backendStartup,
        pendingFirstAgentMessageRename,
        undefined,
        linkedLinearIssueWorkspaceId,
        linkedLinearIssueOrganizationUrlKey,
        undefined,
        undefined,
        undefined,
        submitCompareBaseRef,
        {
          linkedWorkItem: toFolderWorkspaceLinkedTask(submitLinkedWorkItem),
          linkedTaskSourceContext: taskSourceContext,
          nameWasGenerated,
          ...(!backendStartup && startupPlan?.draftPrompt
            ? { startupDraft: startupPlan.draftPrompt }
            : {}),
          ...(parentWorktreeId ? { parentWorktreeId } : {})
        }
      )

      const worktree = result.worktree

      const trimmedNote = note.trim()

      await applyWorktreeMeta(worktree.id, trimmedNote ? { comment: trimmedNote } : {})

      const issueCommand =
        submitShouldRunIssueAutomation && issueCommandTrustDecision === 'run'
          ? {
              command: renderIssueCommandTemplate(confirmedIssueCommandTemplate, {
                issueNumber: submitLinkedIssueNumber,
                artifactUrl: submitLinkedWorkItem?.url ?? null
              })
            }
          : undefined

      const backendSpawnedStartup = result.startupTerminal?.spawned === true

      if (startupPlan && !backendSpawnedStartup && !startupPlan.launchToken) {
        // Why: delayed delivery must target the exact pane from this queued startup, so both halves share one renderer-session token.
        startupPlan.launchToken = createBrowserUuid()
      }

      const activation = activateAndRevealWorktree(worktree.id, {
        sidebarRevealBehavior: 'auto',
        setup: result.setup,
        defaultTabs: result.defaultTabs,
        issueCommand,
        ...(backendSpawnedStartup ? { backendStartupTerminalSpawned: true } : {}),
        ...(startupPlan && !backendSpawnedStartup
          ? {
              startup: {
                command: startupPlan.launchCommand,
                ...(startupPlan.env ? { env: startupPlan.env } : {}),
                launchConfig: startupPlan.launchConfig,
                ...(startupPlan.launchToken ? { launchToken: startupPlan.launchToken } : {}),
                launchAgent: tuiAgent,
                ...(startupPlan.draftPrompt ? { draftPrompt: startupPlan.draftPrompt } : {}),
                ...(startupPlan.startupCommandDelivery
                  ? { startupCommandDelivery: startupPlan.startupCommandDelivery }
                  : {}),
                ...(shouldSeedInitialAgentStatus
                  ? {
                      initialAgentStatus: {
                        agent: tuiAgent,
                        prompt: submitStartupPrompt.trim()
                      }
                    }
                  : {}),
                telemetry: composerTelemetry
              }
            }
          : {})
      })

      if (startupPlan) {
        const optionScopeKey =
          (activation !== false ? activation.primaryTabId : null) ?? result.startupTerminal?.tabId
        if (optionScopeKey) {
          seedNativeChatAppliedSessionOptions(optionScopeKey, tuiAgent, startupPlan.sessionOptions)
        }
      }

      if (startupPlan && !backendSpawnedStartup) {
        void ensureAgentStartupInTerminal({
          worktreeId: worktree.id,
          primaryTabId: activation === false ? null : activation.primaryTabId,
          startup: startupPlan
        })
      }

      setSidebarOpen(true)

      if (persistDraft) {
        clearNewWorkspaceDraft()
      }

      onCreated?.()

      queueWorkspaceActivationTerminalFocus(worktree.id, activation)
    },
    [
      applyWorktreeMeta,
      clearNewWorkspaceDraft,
      createWorktree,
      effectivePresetId,
      isSubmissionCancelled,
      linkedGitLabIssue,
      linkedGitLabMR,
      normalizedSparseDirectories,
      note,
      onCreated,
      parentWorktreeId,
      persistDraft,
      persistSetupAgentStartupPolicy,
      prepareFullSubmit,
      resolvedInitialWorkspaceStatus,
      selectedRepoIsGit,
      setSidebarOpen,
      sparseEnabled,
      taskSourceContext,
      telemetrySource,
      tuiAgent
    ]
  )

  return {
    executeFullCreation
  }
}
