import type { QuickSubmitPreparationInput } from './quick-submit-input-contract'

import { useCallback } from 'react'
import { settleComposerSubmit } from '@/lib/workspace/creation/composer-submit-cancellation'
import { getWorkspaceSourceProvider } from '../../../../shared/new-workspace/workspace-source'
import { canUseIssueCommandForLinkedItemProvider } from '@/lib/workspace/creation/new-workspace'
import { getSetupConfig } from '../../../../shared/orca-hook-setup-config'
import {
  deriveWorkspaceSetupState,
  readWorkspaceSetupInspection,
  getComposerSetupInspectionCommit
} from '@/lib/workspace/creation/setup/workspace-setup-preparation'
import type { SetupDecision } from '../../../../shared/worktree/create-types'
import type { WorktreeCreationRequest } from '@/lib/workspace/creation/pending-worktree-creation'
import { resolveComposerBranchNameOverrideForCreate } from '../composer-branch-selection'
import { resolveFolderSetupSupported } from '@/lib/use-folder-setup-supported'
import { translate } from '@/i18n/i18n'
import { resolveWorktreeCreateBaseBranch } from '@/runtime/source-control/worktree-creation/worktree-create-base'
import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
import type { PendingSmartGitHubSubmitResolution } from './source-selection-decisions'

export function useQuickSubmitPreparation(input: QuickSubmitPreparationInput) {
  const {
    branchAutoNameRef,
    branchIntent,
    branchNameOverridePreservesNameEdits,
    checkedHooksContextKey,
    commitHookCheckIfCurrent,
    enableIssueAutomation,
    isSubmissionCancelled,
    loadHookCheckForRepo,
    name,
    note,
    prepareQuickSubmitSource,
    repoId,
    resolvedSetupDecision,
    selectedRepo,
    selectedRepoExecutionHostId,
    selectedRepoHookContextKey,
    selectedRepoIsGit,
    revealSetupChoice,
    settings,
    setupConfig,
    setupSupport,
    setupDecision,
    setupPolicy,
    smartNameMode
  } = input

  const prepareQuickSubmit = useCallback(
    async (
      smartGitHubResolution: PendingSmartGitHubSubmitResolution,
      requestedAgent: TuiAgent | null,
      workspaceNameSeed: string
    ) => {
      const source = prepareQuickSubmitSource(
        smartGitHubResolution,
        requestedAgent,
        workspaceNameSeed
      )
      if (!source) {
        return null
      }
      const {
        submitLinkedWorkItem,
        agent,
        submitLinkedIssueNumber,
        submitTitleName,
        nameIsAutoManaged,
        smartGitHubCreateNames,
        workspaceName,
        smartSubmitBaseBranch,
        submitBranchNameOverride
      } = source

      let submitSetupConfig = setupConfig

      let submitResolvedSetupDecision = resolvedSetupDecision

      // Create re-asks the host so a pending or stale answer can't drop an ask-policy prompt.
      const supportSettlement = await settleComposerSubmit(
        resolveFolderSetupSupported(selectedRepo).catch(() => {
          throw new Error(
            translate(
              'auto.hooks.useComposerState.folderSetupSupportCheckFailed',
              "Couldn't confirm whether this host runs folder setup scripts. Try again."
            )
          )
        }),
        isSubmissionCancelled
      )
      if (supportSettlement.status === 'cancelled') {
        return null
      }
      const submitSetupSupported = supportSettlement.value
      if (!submitSetupSupported) {
        submitSetupConfig = null
      }

      if (
        submitSetupSupported &&
        (setupSupport !== 'supported' || setupPolicy === 'ask') &&
        selectedRepoHookContextKey &&
        (setupSupport !== 'supported' || checkedHooksContextKey !== selectedRepoHookContextKey)
      ) {
        const outcome = await readWorkspaceSetupInspection(
          () => loadHookCheckForRepo(repoId),
          isSubmissionCancelled
        )
        const commit = getComposerSetupInspectionCommit(outcome, 'submit')
        if (!commit || !commitHookCheckIfCurrent(selectedRepoHookContextKey, commit.hooks)) {
          return null
        }
        const submitSetup = deriveWorkspaceSetupState(
          selectedRepo,
          getSetupConfig(selectedRepo, commit.hooks),
          setupDecision
        )
        submitSetupConfig = submitSetup.setupConfig
        submitResolvedSetupDecision = submitSetup.resolvedSetupDecision
      }

      if (submitSetupConfig && setupPolicy === 'ask' && !setupDecision) {
        revealSetupChoice()
        return null
      }

      // Hosts that predate folder setup ignore the decision for folders.
      const effectiveSetupDecision: SetupDecision = submitResolvedSetupDecision ?? 'inherit'
      const submitLinkedWorkItemProvider = submitLinkedWorkItem
        ? getWorkspaceSourceProvider(submitLinkedWorkItem)
        : null
      // Setup trust applies to folder projects too; the issue command needs a Git repo.
      const hookPreparation: WorktreeCreationRequest['hookPreparation'] = {
        executionHostId: selectedRepoExecutionHostId ?? undefined,
        issueCommand:
          selectedRepoIsGit &&
          enableIssueAutomation &&
          submitLinkedIssueNumber !== null &&
          canUseIssueCommandForLinkedItemProvider(submitLinkedWorkItemProvider) &&
          selectedRepoExecutionHostId &&
          selectedRepoHookContextKey
            ? {
                provider: submitLinkedWorkItemProvider,
                issueNumber: submitLinkedIssueNumber,
                artifactUrl: submitLinkedWorkItem?.url ?? null
              }
            : undefined
      }

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

      const baseBranchSettlement = await settleComposerSubmit(
        selectedRepoIsGit
          ? resolveWorktreeCreateBaseBranch({ explicitBaseBranch: smartSubmitBaseBranch })
          : Promise.resolve(undefined),
        isSubmissionCancelled
      )

      if (baseBranchSettlement.status === 'cancelled') {
        return null
      }

      const submitBaseBranch = baseBranchSettlement.value

      const createDisplayName = !nameIsAutoManaged
        ? workspaceName
        : smartGitHubResolution.kind === 'none'
          ? submitTitleName?.displayName
          : smartGitHubCreateNames.displayName

      // Why: quick create shares the blank-name flow; the card needs an explicit marker, not a guess from the title.
      const pendingFirstAgentMessageRename =
        selectedRepoIsGit &&
        settings?.autoRenameBranchFromWork === true &&
        !name.trim() &&
        Boolean(agent) &&
        !effectiveBranchNameOverride &&
        !createDisplayName

      const trimmedNote = note.trim()

      return Object.assign(source, {
        effectiveSetupDecision,
        hookPreparation,
        linkedLinearIssue,
        linkedLinearIssueWorkspaceId,
        linkedLinearIssueOrganizationUrlKey,
        effectiveBranchNameOverride,
        branchIntent:
          smartGitHubResolution.kind === 'none' &&
          (effectiveBranchNameOverride || branchIntent === 'create-new')
            ? branchIntent
            : undefined,
        submitBaseBranch,
        createDisplayName,
        pendingFirstAgentMessageRename,
        trimmedNote
      })
    },
    [
      branchNameOverridePreservesNameEdits,
      branchIntent,
      checkedHooksContextKey,
      commitHookCheckIfCurrent,
      enableIssueAutomation,
      isSubmissionCancelled,
      loadHookCheckForRepo,
      name,
      note,
      prepareQuickSubmitSource,
      repoId,
      resolvedSetupDecision,
      selectedRepo,
      selectedRepoExecutionHostId,
      selectedRepoHookContextKey,
      selectedRepoIsGit,
      revealSetupChoice,
      settings,
      setupConfig,
      setupSupport,
      setupDecision,
      setupPolicy,
      smartNameMode,
      branchAutoNameRef
    ]
  )

  return {
    prepareQuickSubmit
  }
}
