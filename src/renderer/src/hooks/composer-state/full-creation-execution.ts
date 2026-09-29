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
  | 'selectedRepoExecutionHostId'
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
import { ensureAgentStartupInTerminal } from '@/lib/new-workspace'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { seedNativeChatAppliedSessionOptions } from '@/components/native-chat/native-chat-session-option-cache'
import { queueWorkspaceActivationTerminalFocus } from '@/lib/workspace-activation-terminal-focus'
import { useAppStore } from '@/store'
import { planAgentSessionLaunch } from '@/lib/agent-session-launch-plan'
import { beginFullCreationStructuredLaunch } from './full-creation-structured-launch'
import { finalizeFullCreation } from './full-creation-finalization'
import { buildFullCreationIssueCommand } from './full-creation-issue-command'
import { buildFullCreationStartup } from './full-creation-startup'
import { assignUnassignedGitHubIssueOnStart } from '@/lib/assign-unassigned-github-issue-on-start'

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
    selectedRepoExecutionHostId,
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
        nameIsAutoManaged,
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

      const launchPlan = planAgentSessionLaunch(useAppStore.getState(), {
        agent: tuiAgent,
        workspace: {
          kind: selectedRepoIsGit ? 'git-worktree' : 'folder',
          repoId,
          executionHostId: selectedRepoExecutionHostId ?? undefined
        },
        prompt: startupPlan?.draftPrompt ?? submitStartupPrompt,
        promptDelivery: startupPlan?.draftPrompt ? 'draft' : 'auto-submit',
        initialSessionOptions: startupPlan?.sessionOptions
      })
      const structuredLaunch = launchPlan.route === 'structured-native-chat'
      const effectiveBackendStartup = structuredLaunch ? undefined : backendStartup

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
        effectiveBackendStartup,
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
          ...(createDisplayName
            ? { displayNameKind: nameIsAutoManaged ? ('generated' as const) : ('user' as const) }
            : {}),
          ...(!structuredLaunch && !effectiveBackendStartup && startupPlan?.draftPrompt
            ? { startupDraft: startupPlan.draftPrompt }
            : {}),
          ...(parentWorktreeId ? { parentWorktreeId } : {})
        }
      )

      const worktree = result.worktree
      // Why: assignment is best-effort and can wait on gh; do not delay reveal.
      void assignUnassignedGitHubIssueOnStart({
        enabled: useAppStore.getState().settings?.assignUnassignedGitHubIssuesOnStart === true,
        item: submitLinkedWorkItem,
        repoId,
        sourceContext: taskSourceContext
      }).catch(() => undefined)
      const issueCommand = buildFullCreationIssueCommand({
        shouldRun: submitShouldRunIssueAutomation && issueCommandTrustDecision === 'run',
        template: confirmedIssueCommandTemplate,
        issueNumber: submitLinkedIssueNumber,
        artifactUrl: submitLinkedWorkItem?.url
      })

      const backendSpawnedStartup = result.startupTerminal?.spawned === true

      if (startupPlan && !backendSpawnedStartup && !startupPlan.launchToken) {
        // Why: delayed delivery must target the exact pane from this queued startup, so both halves share one renderer-session token.
        startupPlan.launchToken = createBrowserUuid()
      }

      const startup = buildFullCreationStartup({
        startupPlan,
        backendSpawnedStartup,
        agent: tuiAgent,
        shouldSeedInitialAgentStatus,
        prompt: submitStartupPrompt,
        telemetry: composerTelemetry
      })

      const activationHolder: { value: ReturnType<typeof activateAndRevealWorktree> } = {
        value: false
      }
      const revealWorkspace = (): boolean => {
        activationHolder.value = activateAndRevealWorktree(worktree.id, {
          sidebarRevealBehavior: 'auto',
          agent: tuiAgent,
          setup: result.setup,
          defaultTabs: result.defaultTabs,
          issueCommand,
          ...(backendSpawnedStartup ? { backendStartupTerminalSpawned: true } : {}),
          ...(!structuredLaunch && startup ? { startup } : {}),
          ...(structuredLaunch ? { providesInitialSurface: true } : {})
        })
        return activationHolder.value !== false
      }
      if (structuredLaunch) {
        try {
          beginFullCreationStructuredLaunch({
            plan: launchPlan,
            worktreeId: worktree.id,
            beforeOpen: revealWorkspace
          })
        } catch (error) {
          // Why: a failed reveal must not turn a structured route into a legacy terminal; the
          // completed workspace remains usable and the launch surface can be retried there.
          console.error('full creation: structured chat surface failed', worktree.id, error)
        }
      }
      if (!structuredLaunch) {
        revealWorkspace()
      }
      const structuredLaunchAccepted = structuredLaunch
      const activation = activationHolder.value

      const trimmedNote = note.trim()
      await applyWorktreeMeta(worktree.id, trimmedNote ? { comment: trimmedNote } : {})

      if (!structuredLaunchAccepted && startupPlan) {
        const optionScopeKey =
          (activation !== false ? activation.primaryTabId : null) ?? result.startupTerminal?.tabId
        if (optionScopeKey) {
          seedNativeChatAppliedSessionOptions(optionScopeKey, tuiAgent, startupPlan.sessionOptions)
        }
      }

      if (!structuredLaunchAccepted && startupPlan && !backendSpawnedStartup) {
        void ensureAgentStartupInTerminal({
          worktreeId: worktree.id,
          primaryTabId: activation === false ? null : activation.primaryTabId,
          startup: startupPlan
        })
      }

      finalizeFullCreation({
        setSidebarOpen,
        persistDraft,
        clearNewWorkspaceDraft,
        onCreated,
        structuredLaunchAccepted,
        worktreeId: worktree.id,
        activation,
        queueWorkspaceActivationTerminalFocus
      })
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
      selectedRepoExecutionHostId,
      selectedRepoIsGit,
      setSidebarOpen,
      sparseEnabled,
      taskSourceContext,
      telemetrySource,
      tuiAgent
    ]
  )

  return { executeFullCreation }
}
