import type { ComposerModel } from './composer-model'

type FullSubmitPreparationInput = Pick<
  ComposerModel,
  | 'branchAutoNameRef'
  | 'branchNameOverridePreservesNameEdits'
  | 'currentIssueCommand'
  | 'currentReviewCommand'
  | 'isSubmissionCancelled'
  | 'issueCommandTemplate'
  | 'name'
  | 'prepareFullSubmitSource'
  | 'repoId'
  | 'resolvedSetupDecision'
  | 'selectedRepo'
  | 'selectedRepoAgentLaunchPlatform'
  | 'selectedRepoExecutionHostId'
  | 'selectedRepoIsGit'
  | 'selectedRepoIsRemote'
  | 'selectedRepoStartupShell'
  | 'settings'
  | 'smartNameMode'
  | 'telemetrySource'
  | 'tuiAgent'
>

import { useCallback } from 'react'
import { settleComposerSubmit } from '@/lib/composer-submit-cancellation'
import { ensureHooksConfirmed, confirmRuntimeIssueCommandRead } from '@/lib/ensure-hooks-confirmed'
import { resolveTrustedStartupPrompt } from './full-submit-source-preparation'
import { useAppStore } from '@/store'
import type { SetupDecision } from '../../../../shared/worktree/create-types'
import { resolveComposerBranchNameOverrideForCreate } from '../composer-branch-selection'
import { buildAgentStartupPlan } from '@/lib/tui-agent-startup'
import {
  resolveTuiAgentLaunchArgs,
  resolveTuiAgentLaunchEnv
} from '../../../../shared/tui-agent-launch-defaults'
import { resolveInitialNativeChatSessionOptions } from '@/components/native-chat/native-chat-launch-session-options'
import { isNativeChatTranscriptLocalReadable } from '@/lib/native-chat-transcript-readability'
import type { AgentStartedTelemetry } from '@/lib/worktree-startup-payload'
import { tuiAgentToAgentKind } from '@/lib/telemetry'
import type { PendingSmartGitHubSubmitResolution } from './source-selection-decisions'

export function useFullSubmitPreparation(input: FullSubmitPreparationInput) {
  const {
    branchAutoNameRef,
    branchNameOverridePreservesNameEdits,
    currentIssueCommand,
    currentReviewCommand,
    isSubmissionCancelled,
    issueCommandTemplate,
    name,
    prepareFullSubmitSource,
    repoId,
    resolvedSetupDecision,
    selectedRepo,
    selectedRepoAgentLaunchPlatform,
    selectedRepoExecutionHostId,
    selectedRepoIsGit,
    selectedRepoIsRemote,
    selectedRepoStartupShell,
    settings,
    smartNameMode,
    telemetrySource,
    tuiAgent
  } = input

  const prepareFullSubmit = useCallback(
    async (smartGitHubResolution: PendingSmartGitHubSubmitResolution) => {
      const source = prepareFullSubmitSource(smartGitHubResolution)
      if (!source) {
        return null
      }
      const {
        submitLinkedWorkItem,
        submitTitleName,
        nameIsAutoManaged,
        smartGitHubCreateNames,
        workspaceName,
        submitBranchNameOverride,
        submitLinkedWorkItemProvider,
        submitCommandKind,
        submitShouldApplyLinkedOnlyTemplate,
        submitLinkedOnlyTemplateIsRepoText,
        submitStartupPromptWithoutTemplate,
        submitStartupPromptWithTemplate,
        submitShouldRunIssueAutomation
      } = source

      const setupTrustSettlement = await settleComposerSubmit(
        selectedRepoIsGit
          ? ensureHooksConfirmed(
              useAppStore.getState(),
              repoId,
              'setup',
              selectedRepoExecutionHostId ?? undefined,
              undefined,
              isSubmissionCancelled
            )
          : Promise.resolve<'skip'>('skip'),
        isSubmissionCancelled
      )

      if (setupTrustSettlement.status === 'cancelled') {
        return null
      }

      const setupTrustDecision = setupTrustSettlement.value

      const effectiveSetupDecision: SetupDecision =
        setupTrustDecision === 'skip'
          ? 'skip'
          : ((resolvedSetupDecision ?? 'inherit') as SetupDecision)

      // Why: repository text on the linked-only path becomes the agent's draft prompt, so it
      // starts untrusted and is only promoted by an explicit confirmation — matching quick-submit.
      let issueCommandTrustDecision: 'run' | 'skip' =
        submitShouldApplyLinkedOnlyTemplate && submitLinkedOnlyTemplateIsRepoText ? 'skip' : 'run'

      let confirmedIssueCommandTemplate = issueCommandTemplate

      const submitCurrentCommand =
        submitCommandKind === 'review' ? currentReviewCommand : currentIssueCommand

      if (
        selectedRepoIsGit &&
        (submitShouldRunIssueAutomation || submitShouldApplyLinkedOnlyTemplate) &&
        submitCurrentCommand &&
        selectedRepoExecutionHostId
      ) {
        if (setupTrustDecision === 'skip') {
          issueCommandTrustDecision = 'skip'
        } else {
          const issueCommandSettlement = await settleComposerSubmit(
            confirmRuntimeIssueCommandRead(
              useAppStore.getState(),
              repoId,
              selectedRepoExecutionHostId,
              submitCurrentCommand,
              isSubmissionCancelled,
              submitCommandKind
            ),
            isSubmissionCancelled
          )
          if (issueCommandSettlement.status === 'cancelled') {
            return null
          }
          const confirmed = issueCommandSettlement.value
          issueCommandTrustDecision = confirmed.trustDecision
          confirmedIssueCommandTemplate = confirmed.template
        }
      }

      const submitStartupPrompt = resolveTrustedStartupPrompt({
        applyTemplate: submitShouldApplyLinkedOnlyTemplate,
        templateIsRepoText: submitLinkedOnlyTemplateIsRepoText,
        trustDecision: issueCommandTrustDecision,
        templatePrompt: submitStartupPromptWithTemplate,
        plainPrompt: submitStartupPromptWithoutTemplate
      })

      const linkedLinearIssue =
        submitLinkedWorkItem && submitLinkedWorkItemProvider === 'linear'
          ? submitLinkedWorkItem.linearIdentifier
          : undefined

      const linkedLinearIssueWorkspaceId =
        submitLinkedWorkItem && submitLinkedWorkItemProvider === 'linear'
          ? submitLinkedWorkItem.linearWorkspaceId
          : undefined

      const linkedLinearIssueOrganizationUrlKey =
        submitLinkedWorkItem && submitLinkedWorkItemProvider === 'linear'
          ? submitLinkedWorkItem.linearOrganizationUrlKey
          : undefined

      const effectiveBranchNameOverride = resolveComposerBranchNameOverrideForCreate({
        branchNameOverride: submitBranchNameOverride,
        branchAutoName: branchAutoNameRef.current,
        workspaceName,
        preserveWorkspaceNameEdits:
          smartGitHubResolution.kind === 'pr-start-point' || branchNameOverridePreservesNameEdits,
        createBranchFromWorkspaceName:
          smartGitHubResolution.kind === 'none' && smartNameMode === 'branches'
      })

      const createDisplayName = !nameIsAutoManaged
        ? workspaceName
        : smartGitHubResolution.kind === 'none'
          ? submitTitleName?.displayName
          : smartGitHubCreateNames.displayName

      // Why: the first-work hook only renames blank, auto-generated git workspaces that launch an agent; persist that pending state for the card.
      const pendingFirstAgentMessageRename =
        selectedRepoIsGit &&
        settings?.autoRenameBranchFromWork === true &&
        !name.trim() &&
        Boolean(tuiAgent) &&
        !effectiveBranchNameOverride &&
        !createDisplayName

      const startupPlan = buildAgentStartupPlan({
        agent: tuiAgent,
        prompt: submitStartupPrompt,
        cmdOverrides: settings?.agentCmdOverrides ?? {},
        agentArgs: resolveTuiAgentLaunchArgs(tuiAgent, settings?.agentDefaultArgs),
        agentEnv: resolveTuiAgentLaunchEnv(tuiAgent, settings?.agentDefaultEnv),
        sessionOptions: resolveInitialNativeChatSessionOptions(
          {
            experimentalNativeChat: settings?.experimentalNativeChat,
            openAgentTabsInChatByDefault: settings?.openAgentTabsInChatByDefault,
            nativeChatSessionOptions: settings?.nativeChatSessionOptions
          },
          {
            agent: tuiAgent,
            nativeChatTranscriptIsLocalReadable: isNativeChatTranscriptLocalReadable(
              selectedRepo?.connectionId
            )
          }
        ),
        platform: selectedRepoAgentLaunchPlatform,
        shell: selectedRepoStartupShell,
        isRemote: selectedRepoIsRemote
      })

      const shouldSeedInitialAgentStatus =
        tuiAgent === 'command-code' && submitStartupPrompt.trim().length > 0

      // Why: backend startup is safe only for self-contained launch commands; agents needing post-ready paste stay on the renderer path.
      const composerTelemetry: AgentStartedTelemetry = {
        agent_kind: tuiAgentToAgentKind(tuiAgent),
        launch_source: telemetrySource === 'onboarding' ? 'onboarding' : 'new_workspace_composer',
        request_kind: 'new'
      }

      const backendStartup =
        startupPlan && !startupPlan.draftPrompt && !startupPlan.followupPrompt
          ? {
              command: startupPlan.launchCommand,
              ...(startupPlan.env ? { env: startupPlan.env } : {}),
              launchConfig: startupPlan.launchConfig,
              launchAgent: tuiAgent,
              ...(startupPlan.startupCommandDelivery
                ? { startupCommandDelivery: startupPlan.startupCommandDelivery }
                : {}),
              telemetry: composerTelemetry
            }
          : undefined

      return Object.assign(source, {
        submitStartupPrompt,
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
      })
    },
    [
      branchNameOverridePreservesNameEdits,
      currentIssueCommand,
      currentReviewCommand,
      isSubmissionCancelled,
      issueCommandTemplate,
      name,
      prepareFullSubmitSource,
      repoId,
      resolvedSetupDecision,
      selectedRepo,
      selectedRepoAgentLaunchPlatform,
      selectedRepoExecutionHostId,
      selectedRepoIsGit,
      selectedRepoIsRemote,
      selectedRepoStartupShell,
      settings,
      smartNameMode,
      telemetrySource,
      tuiAgent,
      branchAutoNameRef
    ]
  )

  return {
    prepareFullSubmit
  }
}
