import { projectGroupHookOwner } from '../../../../shared/workspace-hook-owner'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import { PROJECT_GROUP_FOLDER_SETUP_RUNTIME_CAPABILITY } from '../../../../shared/worktree-runtime-capabilities'
import { resolveFolderSetupSupported } from '@/lib/workspace/creation/setup/folder-setup-support'
import { checkRuntimeGroupHooks } from '@/runtime/repo-hooks/runtime-hooks-client'
import { deriveWorkspaceSetupState } from '@/lib/workspace/creation/setup/workspace-setup-preparation'
import { getSetupConfig } from '../../../../shared/orca-hook-setup-config'
import { confirmWorkspaceSetupDecision } from '@/lib/workspace/creation/setup/workspace-setup-trust'
import { useAppStore } from '@/store'
import type { QuickSubmitOptions } from './quick-creation-request'
import type { ComposerModel } from './composer-model'

type FolderSubmitOrchestrationInput = Pick<
  ComposerModel,
  | 'groupSetup'
  | 'revealSetupChoice'
  | 'clearNewWorkspaceDraft'
  | 'createFolderWorkspace'
  | 'decisions'
  | 'disabledTuiAgents'
  | 'folderCreateDisabled'
  | 'folderSourceRepos'
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
import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
import { settleComposerSubmit } from '@/lib/workspace/creation/composer-submit-cancellation'
import { isTuiAgentEnabled } from '../../../../shared/agent-launch/catalog/tui-agent-selection'
import { submitFolderWorkspaceCreate } from '@/components/sidebar/workspace-creation/folder/folder-workspace-composer-submit'
import { translate } from '@/i18n/i18n'
import {
  formatWorkspaceCreateError,
  getWorkspaceCreateErrorToastMessage
} from '@/lib/workspace/creation/workspace-create-error-format'
import { toast } from 'sonner'

export function useFolderSubmitOrchestration(input: FolderSubmitOrchestrationInput) {
  const {
    groupSetup,
    revealSetupChoice,
    clearNewWorkspaceDraft,
    createFolderWorkspace,
    decisions,
    disabledTuiAgents,
    folderCreateDisabled,
    folderSourceRepos,
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
    async (requestedAgent: TuiAgent | null, options?: QuickSubmitOptions): Promise<void> => {
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
        const policySettlement = await settleComposerSubmit(
          groupSetup.waitForStartupPolicySave(),
          isSubmissionCancelled
        )
        if (policySettlement.status === 'cancelled' || !policySettlement.value) {
          return
        }
        const owner = projectGroupHookOwner(selectedProjectGroup)
        const setupSupported = await resolveFolderSetupSupported(
          owner,
          PROJECT_GROUP_FOLDER_SETUP_RUNTIME_CAPABILITY
        )
        let setupApproval = {}
        if (owner && setupSupported) {
          const inspected = await checkRuntimeGroupHooks(
            getRepoExecutionHostId(selectedProjectGroup),
            selectedProjectGroup.id
          )
          if (isSubmissionCancelled()) {
            return
          }
          groupSetup.commitHooks(inspected)
          const inspectedGroup = { ...selectedProjectGroup, hookSettings: inspected.hookSettings }
          const setup = deriveWorkspaceSetupState(
            inspectedGroup,
            getSetupConfig({ ...owner, hookSettings: inspected.hookSettings }, inspected.hooks),
            groupSetup.decision
          )
          if (setup.requiresExplicitSetupChoice && !groupSetup.decision) {
            revealSetupChoice()
            return
          }
          const confirmed = await confirmWorkspaceSetupDecision(
            useAppStore.getState,
            owner.id,
            setup.resolvedSetupDecision ?? 'inherit',
            getRepoExecutionHostId(selectedProjectGroup),
            isSubmissionCancelled
          )
          if (confirmed === 'cancelled') {
            return
          }
          setupApproval = confirmed
        }
        if (isSubmissionCancelled()) {
          return
        }
        const folderWorkspaceCreated = await submitFolderWorkspaceCreate({
          projectGroup: selectedProjectGroup,
          setupSupported,
          setupApproval,
          isCancelled: isSubmissionCancelled,
          name: smartGitHubMetadata?.workspaceName ?? name,
          lastAutoName: lastAutoNameRef.current,
          linkedWorkItem: submitLinkedWorkItem,
          linkedTaskSourceContext: taskSourceContext,
          note,
          quickAgent: agent,
          launchChoice: options?.launchChoice,
          launchInputs: options?.launchInputs,
          legacyLaunchInputs: options?.legacyLaunchInputs,
          autoRenameBranchFromWork: settings?.autoRenameBranchFromWork,
          settings: settings ?? undefined,
          agentCmdOverrides: settings?.agentCmdOverrides,
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
      groupSetup,
      revealSetupChoice,
      clearNewWorkspaceDraft,
      createFolderWorkspace,
      canResolveFolderSmartGitHubSubmit,
      disabledTuiAgents,
      folderCreateDisabled,
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
      settings,
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
