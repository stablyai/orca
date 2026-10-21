import type { QuickSubmitPreparationInput } from './quick-submit-input-contract'

import { useCallback } from 'react'
import type { HookCheckResult } from '@/runtime/runtime-hooks-client'
import { settleComposerSubmit } from '@/lib/composer-submit-cancellation'
import {
  getSetupConfig,
  getLinkedWorkItemProvider,
  canUseIssueCommandForLinkedItemProvider
} from '@/lib/new-workspace'
import type { SetupDecision } from '../../../../shared/worktree/create-types'
import type { WorktreeCreationRequest } from '@/lib/pending-worktree-creation'
import { resolveComposerBranchNameOverrideForCreate } from '../composer-branch-selection'
import { resolveWorktreeCreateBaseBranch } from '@/runtime/worktree-create-base'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { PendingSmartGitHubSubmitResolution } from './source-selection-decisions'

export function useQuickSubmitPreparation(input: QuickSubmitPreparationInput) {
  const {
    branchAutoNameRef,
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
        let hookCheck: HookCheckResult
        try {
          const hookCheckSettlement = await settleComposerSubmit(
            loadHookCheckForRepo(repoId),
            isSubmissionCancelled
          )
          if (hookCheckSettlement.status === 'cancelled') {
            return null
          }
          hookCheck = hookCheckSettlement.value
        } catch {
          hookCheck = { hasHooks: false, hooks: null, mayNeedUpdate: false }
        }
        if (!commitHookCheckIfCurrent(selectedRepoHookContextKey, hookCheck.hooks)) {
          return null
        }
        submitSetupConfig = getSetupConfig(selectedRepo, hookCheck.hooks)
        submitResolvedSetupDecision =
          setupDecision ??
          (!submitSetupConfig || setupPolicy === 'ask'
            ? null
            : setupPolicy === 'run-by-default'
              ? 'run'
              : 'skip')
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
      const hookPreparation: WorktreeCreationRequest['hookPreparation'] = selectedRepoIsGit
        ? {
            executionHostId: selectedRepoExecutionHostId ?? undefined,
            issueCommand:
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
        submitBaseBranch,
        createDisplayName,
        pendingFirstAgentMessageRename,
        trimmedNote
      })
    },
    [
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
      smartNameMode,
      branchAutoNameRef
    ]
  )

  return {
    prepareQuickSubmit
  }
}
