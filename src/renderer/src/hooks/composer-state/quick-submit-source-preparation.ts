import type { ComposerModel } from './composer-model'

type QuickSubmitSourcePreparationInput = Pick<
  ComposerModel,
  | 'baseBranch'
  | 'branchNameOverride'
  | 'compareBaseRef'
  | 'disabledTuiAgents'
  | 'effectiveLinkedPR'
  | 'decisions'
  | 'fallbackCreatureName'
  | 'lastAutoNameRef'
  | 'linkedGitLabMR'
  | 'linkedWorkItem'
  | 'name'
  | 'parsedLinkedIssueNumber'
  | 'pushTarget'
>

import { useCallback } from 'react'
import { isTuiAgentEnabled } from '../../../../shared/tui-agent-selection'
import { getLinkedWorkItemWorkspaceName } from '@/lib/new-workspace'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { PendingSmartGitHubSubmitResolution } from './source-selection-decisions'

export function useQuickSubmitSourcePreparation(input: QuickSubmitSourcePreparationInput) {
  const {
    baseBranch,
    branchNameOverride,
    compareBaseRef,
    disabledTuiAgents,
    effectiveLinkedPR,
    decisions,
    fallbackCreatureName,
    lastAutoNameRef,
    linkedGitLabMR,
    linkedWorkItem,
    name,
    parsedLinkedIssueNumber,
    pushTarget
  } = input
  const { isExplicitWorkspaceNameInput, resolveSmartGitHubCreateNames } = decisions

  const prepareQuickSubmitSource = useCallback(
    (
      smartGitHubResolution: PendingSmartGitHubSubmitResolution,
      requestedAgent: TuiAgent | null,
      workspaceNameSeed: string
    ) => {
      const submitLinkedWorkItem =
        smartGitHubResolution.kind === 'none'
          ? linkedWorkItem
          : smartGitHubResolution.linkedWorkItem

      const agent =
        requestedAgent && isTuiAgentEnabled(requestedAgent, disabledTuiAgents)
          ? requestedAgent
          : null

      const submitLinkedIssueNumber =
        smartGitHubResolution.kind === 'none'
          ? parsedLinkedIssueNumber
          : smartGitHubResolution.linkedIssueNumber

      const submitLinkedPR =
        smartGitHubResolution.kind === 'none' ? effectiveLinkedPR : smartGitHubResolution.linkedPR

      const submitTitleName = submitLinkedWorkItem
        ? getLinkedWorkItemWorkspaceName(submitLinkedWorkItem)
        : null

      const nameIsAutoManaged = !isExplicitWorkspaceNameInput({
        name,
        lastAutoName: lastAutoNameRef.current
      })

      const smartGitHubCreateNames =
        smartGitHubResolution.kind === 'none'
          ? { workspaceName: workspaceNameSeed, displayName: undefined }
          : resolveSmartGitHubCreateNames({
              resolutionKind: smartGitHubResolution.kind,
              smartWorkspaceName: smartGitHubResolution.workspaceName,
              smartDisplayName: smartGitHubResolution.displayName,
              fallbackWorkspaceName: workspaceNameSeed,
              nameIsAutoManaged
            })

      const workspaceName =
        smartGitHubResolution.kind === 'none'
          ? nameIsAutoManaged && submitTitleName
            ? submitTitleName.seedName
            : workspaceNameSeed
          : smartGitHubCreateNames.workspaceName

      if (!workspaceName) {
        return null
      }

      // Why: only a name Orca generated may be retired — see the full-composer submit path.
      const nameWasGenerated = !name.trim() && workspaceName === fallbackCreatureName

      const smartSubmitBaseBranch =
        smartGitHubResolution.kind === 'pr-start-point'
          ? smartGitHubResolution.baseBranch
          : smartGitHubResolution.kind === 'metadata-only' &&
              (effectiveLinkedPR !== null || linkedGitLabMR !== null)
            ? undefined
            : baseBranch

      const submitCompareBaseRef =
        smartGitHubResolution.kind === 'pr-start-point'
          ? smartGitHubResolution.compareBaseRef
          : smartGitHubResolution.kind === 'none'
            ? compareBaseRef
            : undefined

      const submitPushTarget =
        smartGitHubResolution.kind === 'pr-start-point'
          ? smartGitHubResolution.pushTarget
          : smartGitHubResolution.kind === 'none'
            ? pushTarget
            : undefined

      const submitBranchNameOverride =
        smartGitHubResolution.kind === 'pr-start-point'
          ? smartGitHubResolution.branchNameOverride
          : smartGitHubResolution.kind === 'none'
            ? branchNameOverride
            : undefined

      return {
        submitLinkedWorkItem,
        agent,
        submitLinkedIssueNumber,
        submitLinkedPR,
        submitTitleName,
        nameIsAutoManaged,
        smartGitHubCreateNames,
        workspaceName,
        nameWasGenerated,
        smartSubmitBaseBranch,
        submitCompareBaseRef,
        submitPushTarget,
        submitBranchNameOverride
      }
    },
    [
      baseBranch,
      branchNameOverride,
      disabledTuiAgents,
      effectiveLinkedPR,
      fallbackCreatureName,
      linkedGitLabMR,
      isExplicitWorkspaceNameInput,
      linkedWorkItem,
      name,
      parsedLinkedIssueNumber,
      resolveSmartGitHubCreateNames,
      pushTarget,
      compareBaseRef,
      lastAutoNameRef
    ]
  )

  return {
    prepareQuickSubmitSource
  }
}
