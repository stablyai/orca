import type { ComposerModel } from './composer-model'

type FolderSubmitOrchestrationInput = Pick<
  ComposerModel,
  | 'clearNewWorkspaceDraft'
  | 'createFolderWorkspace'
  | 'decisions'
  | 'disabledTuiAgents'
  | 'folderCreateDisabled'
  | 'folderSourceRepos'
  | 'folderTargetConnectionId'
  | 'folderTargetIsRemote'
  | 'folderTargetRuntimeEnvironmentId'
  | 'isSubmissionCancelled'
  | 'lastAutoNameRef'
  | 'linkedWorkItem'
  | 'name'
  | 'note'
  | 'onCreated'
  | 'persistDraft'
  | 'resolvePendingSmartGitHubSubmit'
  | 'selectedProjectGroup'
  | 'setCreateError'
  | 'setCreating'
  | 'settings'
  | 'taskSourceContext'
  | 'telemetrySource'
>

import { useCallback } from 'react'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { settleComposerSubmit } from '@/lib/composer-submit-cancellation'
import { isTuiAgentEnabled } from '../../../../shared/tui-agent-selection'
import {
  resolveFolderWorkspaceLaunchDraft,
  submitFolderWorkspaceCreate
} from '@/components/sidebar/folder-workspace-composer-submit'
import {
  resolveTuiAgentLaunchArgs,
  resolveTuiAgentLaunchEnv
} from '../../../../shared/tui-agent-launch-defaults'
import { resolveInitialNativeChatSessionOptions } from '@/components/native-chat/native-chat-launch-session-options'
import { isNativeChatTranscriptLocalReadable } from '@/lib/native-chat-transcript-readability'
import { translate } from '@/i18n/i18n'
import {
  formatWorkspaceCreateError,
  getWorkspaceCreateErrorToastMessage
} from '@/lib/workspace-create-error-format'
import { toast } from 'sonner'

export function useFolderSubmitOrchestration(input: FolderSubmitOrchestrationInput) {
  const {
    clearNewWorkspaceDraft,
    createFolderWorkspace,
    decisions,
    disabledTuiAgents,
    folderCreateDisabled,
    folderSourceRepos,
    folderTargetConnectionId,
    folderTargetIsRemote,
    folderTargetRuntimeEnvironmentId,
    isSubmissionCancelled,
    lastAutoNameRef,
    linkedWorkItem,
    name,
    note,
    onCreated,
    persistDraft,
    resolvePendingSmartGitHubSubmit,
    selectedProjectGroup,
    setCreateError,
    setCreating,
    settings,
    taskSourceContext,
    telemetrySource
  } = input
  const { canResolveFolderSmartGitHubSubmit } = decisions

  const submitFolderTarget = useCallback(
    async (requestedAgent: TuiAgent | null): Promise<void> => {
      if (!selectedProjectGroup?.parentPath || folderCreateDisabled) {
        return
      }
      setCreateError(null)
      setCreating(true)
      try {
        const shouldResolveSmartGitHubSubmit = canResolveFolderSmartGitHubSubmit({
          hasFolderSourceRepos: folderSourceRepos.length > 0
        })
        const smartGitHubSettlement = await settleComposerSubmit(
          shouldResolveSmartGitHubSubmit
            ? resolvePendingSmartGitHubSubmit()
            : Promise.resolve({ kind: 'none' } as const),
          isSubmissionCancelled
        )
        if (smartGitHubSettlement.status === 'cancelled') {
          return
        }
        const smartGitHubResolution = smartGitHubSettlement.value
        const smartGitHubMetadata =
          smartGitHubResolution.kind === 'none' ? null : smartGitHubResolution
        const submitLinkedWorkItem = smartGitHubMetadata?.linkedWorkItem ?? linkedWorkItem
        const agent =
          requestedAgent && isTuiAgentEnabled(requestedAgent, disabledTuiAgents)
            ? requestedAgent
            : null
        if (isSubmissionCancelled()) {
          return
        }
        const folderLaunchDraftText =
          agent && submitLinkedWorkItem
            ? resolveFolderWorkspaceLaunchDraft(submitLinkedWorkItem, note)
            : null
        const folderWorkspaceCreated = await submitFolderWorkspaceCreate({
          projectGroup: selectedProjectGroup,
          name: smartGitHubMetadata?.workspaceName ?? name,
          lastAutoName: lastAutoNameRef.current,
          linkedWorkItem: submitLinkedWorkItem,
          linkedTaskSourceContext: taskSourceContext,
          note,
          quickAgent: agent,
          autoRenameBranchFromWork: settings?.autoRenameBranchFromWork,
          agentCmdOverrides: settings?.agentCmdOverrides,
          agentArgs: agent
            ? resolveTuiAgentLaunchArgs(agent, settings?.agentDefaultArgs)
            : undefined,
          agentEnv: agent ? resolveTuiAgentLaunchEnv(agent, settings?.agentDefaultEnv) : undefined,
          sessionOptions: agent
            ? resolveInitialNativeChatSessionOptions(
                {
                  experimentalNativeChat: settings?.experimentalNativeChat,
                  openAgentTabsInChatByDefault: settings?.openAgentTabsInChatByDefault,
                  nativeChatSessionOptions: settings?.nativeChatSessionOptions
                },
                {
                  agent,
                  ...(folderLaunchDraftText
                    ? { promptDelivery: 'draft' as const, launchDraftText: folderLaunchDraftText }
                    : {}),
                  nativeChatTranscriptIsLocalReadable:
                    isNativeChatTranscriptLocalReadable(folderTargetConnectionId)
                }
              )
            : undefined,
          terminalWindowsShell: settings?.terminalWindowsShell,
          isRemote: folderTargetIsRemote,
          launchSource: telemetrySource === 'onboarding' ? 'onboarding' : 'new_workspace_composer',
          runtimeEnvironmentId: folderTargetRuntimeEnvironmentId,
          createFolderWorkspace: (input) =>
            createFolderWorkspace(input, {
              runtimeEnvironmentId: folderTargetRuntimeEnvironmentId
            }),
          onOpenChange: (open) => {
            if (!open) {
              if (persistDraft) {
                clearNewWorkspaceDraft()
              }
              onCreated?.()
            }
          }
        })
        if (!folderWorkspaceCreated) {
          setCreateError({
            title: translate(
              'auto.hooks.useComposerState.folderWorkspaceCreateFailedTitle',
              'Folder workspace creation failed'
            ),
            message: translate(
              'auto.hooks.useComposerState.folderWorkspaceCreateFailedMessage',
              'The folder workspace could not be created. Check the error details above, then try again.'
            )
          })
        }
      } catch (error) {
        if (isSubmissionCancelled()) {
          return
        }
        const formattedError = formatWorkspaceCreateError(error)
        setCreateError(formattedError)
        toast.error(getWorkspaceCreateErrorToastMessage(formattedError))
      } finally {
        setCreating(false)
      }
    },
    [
      clearNewWorkspaceDraft,
      createFolderWorkspace,
      canResolveFolderSmartGitHubSubmit,
      disabledTuiAgents,
      folderCreateDisabled,
      folderTargetConnectionId,
      folderTargetIsRemote,
      folderTargetRuntimeEnvironmentId,
      folderSourceRepos.length,
      isSubmissionCancelled,
      linkedWorkItem,
      name,
      note,
      onCreated,
      persistDraft,
      resolvePendingSmartGitHubSubmit,
      selectedProjectGroup,
      settings?.agentCmdOverrides,
      settings?.agentDefaultArgs,
      settings?.agentDefaultEnv,
      settings?.autoRenameBranchFromWork,
      settings?.experimentalNativeChat,
      settings?.nativeChatSessionOptions,
      settings?.openAgentTabsInChatByDefault,
      settings?.terminalWindowsShell,
      taskSourceContext,
      telemetrySource,
      lastAutoNameRef,
      setCreateError,
      setCreating
    ]
  )

  return {
    submitFolderTarget
  }
}
