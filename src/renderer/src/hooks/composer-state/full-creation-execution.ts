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
  | 'selectedRepoIsRemote'
  | 'setSidebarOpen'
  | 'settings'
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
import { CLIENT_PLATFORM, ensureAgentStartupInTerminal } from '@/lib/new-workspace'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { seedNativeChatAppliedSessionOptions } from '@/components/native-chat/native-chat-session-option-cache'
import { queueWorkspaceActivationTerminalFocus } from '@/lib/workspace-activation-terminal-focus'
import {
  hasExplicitTuiLaunchCustomization,
  resolveAgentLaunchRoute
} from '@/lib/agent-launch-routing'
import { readLocalRuntimeCapabilities } from '@/runtime/local-runtime-capabilities'
import { settleFullCreationStructuredLaunch } from './full-creation-structured-launch'
import { finalizeFullCreation } from './full-creation-finalization'
import { buildFullCreationIssueCommand } from './full-creation-issue-command'
import { buildFullCreationStartup } from './full-creation-startup'

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
    selectedRepoIsRemote,
    setSidebarOpen,
    settings,
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

      const agentLaunchRoute = resolveAgentLaunchRoute({
        agent: tuiAgent,
        settings,
        executionHostId: selectedRepoExecutionHostId ?? 'local',
        platform: CLIENT_PLATFORM,
        hostCapabilities: readLocalRuntimeCapabilities(),
        workspaceKind: selectedRepoIsGit ? 'git-worktree' : 'folder',
        promptDelivery: startupPlan?.draftPrompt ? 'draft' : 'auto-submit',
        launchText: startupPlan?.draftPrompt ?? submitStartupPrompt,
        nativeChatTranscriptIsLocalReadable: !selectedRepoIsRemote,
        requiresTuiLaunchCustomization: hasExplicitTuiLaunchCustomization(settings, tuiAgent),
        initialSessionOptions: startupPlan?.sessionOptions
      })
      const structuredLaunch = agentLaunchRoute === 'structured-native-chat'
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
        structuredLaunch ? false : pendingFirstAgentMessageRename,
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

      const trimmedNote = note.trim()

      await applyWorktreeMeta(worktree.id, trimmedNote ? { comment: trimmedNote } : {})

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

      const initialActivation = activateAndRevealWorktree(worktree.id, {
        sidebarRevealBehavior: 'auto',
        setup: result.setup,
        defaultTabs: result.defaultTabs,
        issueCommand,
        ...(backendSpawnedStartup ? { backendStartupTerminalSpawned: true } : {}),
        ...(!structuredLaunch && startup ? { startup } : {}),
        ...(structuredLaunch ? { providesInitialSurface: true } : {})
      })

      const { structuredLaunchAccepted, visibilityUnknown, activation } =
        await settleFullCreationStructuredLaunch({
          structuredLaunch,
          agent: tuiAgent,
          worktreeId: worktree.id,
          prompt: startupPlan?.draftPrompt ?? submitStartupPrompt,
          initialActivation,
          onDefinitiveRefusal: async () => {
            if (pendingFirstAgentMessageRename) {
              await applyWorktreeMeta(worktree.id, { pendingFirstAgentMessageRename: true }).catch(
                () => undefined
              )
            }
            return activateAndRevealWorktree(worktree.id, {
              sidebarRevealBehavior: 'auto',
              createNewTerminalForStartup: true,
              ...(startup ? { startup } : {})
            })
          }
        })

      if (visibilityUnknown) {
        setSidebarOpen(true)
        onCreated?.()
        return
      }

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
      selectedRepoIsRemote,
      setSidebarOpen,
      settings,
      sparseEnabled,
      taskSourceContext,
      telemetrySource,
      tuiAgent
    ]
  )

  return { executeFullCreation }
}
