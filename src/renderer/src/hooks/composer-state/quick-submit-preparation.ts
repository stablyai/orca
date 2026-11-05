import type { QuickSubmitPreparationInput } from './quick-submit-input-contract'

import { useCallback } from 'react'
import { settleComposerSubmit } from '@/lib/composer-submit-cancellation'
import {
  getLinkedWorkItemProvider,
  canUseIssueCommandForLinkedItemProvider
} from '@/lib/new-workspace'
import { getSetupConfig } from '../../../../shared/orca-hook-setup-config'
import {
  deriveWorkspaceSetupState,
  readWorkspaceSetupInspection,
  getComposerSetupInspectionCommit
} from '@/lib/workspace-setup-preparation'
import type { SetupDecision } from '../../../../shared/worktree/create-types'
import type { WorktreeCreationRequest } from '@/lib/pending-worktree-creation'
import { resolveComposerBranchNameOverrideForCreate } from '../composer-branch-selection'
import { resolveWorktreeCreateBaseBranch } from '@/runtime/worktree-create-base'
import { readAndConfirmRuntimeIssueCommand } from '@/lib/ensure-hooks-confirmed'
import { resolveLinkedOnlyTemplatePrompt } from '@/lib/composer-issue-command'
import { useAppStore } from '@/store'
import { getRepoCommandKindForLinkedItemType } from '../../../../shared/repo-command-kind'
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
    setAdvancedOpen,
    settings,
    setupConfig,
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

      if (
        selectedRepoIsGit &&
        setupPolicy === 'ask' &&
        selectedRepoHookContextKey &&
        checkedHooksContextKey !== selectedRepoHookContextKey
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

      if (selectedRepoIsGit && submitSetupConfig && setupPolicy === 'ask' && !setupDecision) {
        setAdvancedOpen(true)
        return null
      }

      const effectiveSetupDecision: SetupDecision = selectedRepoIsGit
        ? (submitResolvedSetupDecision ?? 'inherit')
        : 'skip'
      const submitLinkedWorkItemProvider = submitLinkedWorkItem
        ? getLinkedWorkItemProvider(submitLinkedWorkItem)
        : null
      const submitCommandKind = getRepoCommandKindForLinkedItemType(submitLinkedWorkItem?.type)
      // Issues key off the typed/parsed issue number; PRs and MRs off the linked item.
      const submitLinkedTemplateNumber =
        submitCommandKind === 'issue'
          ? submitLinkedIssueNumber
          : (submitLinkedWorkItem?.number ?? null)
      // With no note, the repo template becomes the agent's draft, so it is read and trusted
      // here: the draft is baked into the launch before deferred hook preparation runs.
      const usesLinkedOnlyTemplate =
        enableIssueAutomation &&
        selectedRepoIsGit &&
        agent !== null &&
        !note.trim() &&
        Boolean(submitLinkedWorkItem?.url) &&
        submitLinkedTemplateNumber !== null &&
        canUseIssueCommandForLinkedItemProvider(submitLinkedWorkItemProvider) &&
        Boolean(selectedRepoExecutionHostId)
      let linkedOnlyTemplatePrompt = ''
      if (usesLinkedOnlyTemplate && selectedRepoExecutionHostId) {
        const templateSettlement = await settleComposerSubmit(
          readAndConfirmRuntimeIssueCommand(
            useAppStore.getState(),
            repoId,
            selectedRepoExecutionHostId,
            isSubmissionCancelled,
            { kind: submitCommandKind, usage: 'prompt' }
          ),
          isSubmissionCancelled
        )
        if (templateSettlement.status === 'cancelled') {
          return null
        }
        linkedOnlyTemplatePrompt = resolveLinkedOnlyTemplatePrompt({
          trustDecision: templateSettlement.value.trustDecision,
          note,
          kind: submitCommandKind,
          number: submitLinkedTemplateNumber,
          artifactUrl: submitLinkedWorkItem?.url ?? null,
          template: templateSettlement.value.template
        })
      }

      const hookPreparation: WorktreeCreationRequest['hookPreparation'] = selectedRepoIsGit
        ? {
            executionHostId: selectedRepoExecutionHostId ?? undefined,
            issueCommand:
              // The template was already decided as the prompt; it must not also run as a shell command.
              !usesLinkedOnlyTemplate &&
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
        : undefined

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
        trimmedNote,
        linkedOnlyTemplatePrompt
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
      setAdvancedOpen,
      settings,
      setupConfig,
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
