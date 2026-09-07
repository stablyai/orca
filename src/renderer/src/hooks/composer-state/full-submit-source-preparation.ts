import type { ComposerModel } from './composer-model'

type FullSubmitSourcePreparationInput = Pick<
  ComposerModel,
  | 'agentPrompt'
  | 'attachmentPaths'
  | 'baseBranch'
  | 'branchNameOverride'
  | 'compareBaseRef'
  | 'effectiveLinkedPR'
  | 'decisions'
  | 'enableIssueAutomation'
  | 'fallbackCreatureName'
  | 'hasLoadedIssueCommand'
  | 'issueCommandTemplate'
  | 'lastAutoNameRef'
  | 'linkedGitLabMR'
  | 'linkedWorkItem'
  | 'name'
  | 'parsedLinkedIssueNumber'
  | 'pushTarget'
  | 'workspaceSeedName'
>

import { useCallback } from 'react'
import {
  getLinkedWorkItemWorkspaceName,
  getLinkedWorkItemProvider,
  canUseIssueCommandForLinkedItemProvider,
  renderIssueCommandTemplate,
  DEFAULT_ISSUE_COMMAND_TEMPLATE,
  buildAgentPromptWithContext
} from '@/lib/new-workspace'
import { getLinkedWorkItemPromptContext } from '@/lib/linked-work-item-context'
import type { PendingSmartGitHubSubmitResolution } from './source-selection-decisions'

export function useFullSubmitSourcePreparation(input: FullSubmitSourcePreparationInput) {
  const {
    agentPrompt,
    attachmentPaths,
    baseBranch,
    branchNameOverride,
    compareBaseRef,
    decisions,
    effectiveLinkedPR,
    enableIssueAutomation,
    fallbackCreatureName,
    hasLoadedIssueCommand,
    issueCommandTemplate,
    lastAutoNameRef,
    linkedGitLabMR,
    linkedWorkItem,
    name,
    parsedLinkedIssueNumber,
    pushTarget,
    workspaceSeedName
  } = input
  const { isExplicitWorkspaceNameInput, resolveSmartGitHubCreateNames } = decisions

  const prepareFullSubmitSource = useCallback(
    (smartGitHubResolution: PendingSmartGitHubSubmitResolution) => {
      const submitLinkedWorkItem =
        smartGitHubResolution.kind === 'none'
          ? linkedWorkItem
          : smartGitHubResolution.linkedWorkItem

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
          ? { workspaceName: workspaceSeedName, displayName: undefined }
          : resolveSmartGitHubCreateNames({
              resolutionKind: smartGitHubResolution.kind,
              smartWorkspaceName: smartGitHubResolution.workspaceName,
              smartDisplayName: smartGitHubResolution.displayName,
              fallbackWorkspaceName: workspaceSeedName,
              nameIsAutoManaged
            })

      const workspaceName =
        smartGitHubResolution.kind === 'none'
          ? nameIsAutoManaged && submitTitleName
            ? submitTitleName.seedName
            : workspaceSeedName
          : smartGitHubCreateNames.workspaceName

      if (!workspaceName) {
        return null
      }

      // Why: only a name Orca generated may be retired — the creature pool contains ordinary words
      // ("orca", "runner", "molly") a user can type deliberately and expect to reuse.
      // The identity check is what a linked PR/issue seed makes necessary here; mobile's blank-create
      // path (NewWorktreeModal, `nameWasGenerated: !trimmedName`) has no other seed, so it can't
      // share this expression. Same rule, two submit paths — change both together.
      const nameWasGenerated = !name.trim() && workspaceName === fallbackCreatureName

      const submitBaseBranch =
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

      const submitLinkedWorkItemProvider = submitLinkedWorkItem
        ? getLinkedWorkItemProvider(submitLinkedWorkItem)
        : null

      const submitShouldApplyLinkedOnlyTemplate =
        enableIssueAutomation &&
        !agentPrompt.trim() &&
        Boolean(submitLinkedWorkItem) &&
        hasLoadedIssueCommand &&
        canUseIssueCommandForLinkedItemProvider(submitLinkedWorkItemProvider)

      const submitLinkedOnlyTemplatePrompt =
        submitShouldApplyLinkedOnlyTemplate && submitLinkedWorkItem
          ? renderIssueCommandTemplate(
              issueCommandTemplate.trim() || DEFAULT_ISSUE_COMMAND_TEMPLATE,
              {
                issueNumber:
                  submitLinkedWorkItem.type === 'issue' ? submitLinkedWorkItem.number : null,
                artifactUrl: submitLinkedWorkItem.url
              }
            )
          : ''

      const linkedPromptContext = getLinkedWorkItemPromptContext(submitLinkedWorkItem)

      const submitStartupPrompt = submitShouldApplyLinkedOnlyTemplate
        ? buildAgentPromptWithContext(
            submitLinkedOnlyTemplatePrompt,
            attachmentPaths,
            [],
            linkedPromptContext.linkedContextBlocks
          )
        : buildAgentPromptWithContext(
            agentPrompt,
            attachmentPaths,
            linkedPromptContext.linkedUrls,
            linkedPromptContext.linkedContextBlocks
          )

      const submitShouldRunIssueAutomation =
        enableIssueAutomation &&
        canUseIssueCommandForLinkedItemProvider(submitLinkedWorkItemProvider) &&
        submitLinkedIssueNumber !== null &&
        issueCommandTemplate.length > 0 &&
        !submitShouldApplyLinkedOnlyTemplate

      return {
        submitLinkedWorkItem,
        submitLinkedIssueNumber,
        submitLinkedPR,
        submitTitleName,
        nameIsAutoManaged,
        smartGitHubCreateNames,
        workspaceName,
        nameWasGenerated,
        submitBaseBranch,
        submitCompareBaseRef,
        submitPushTarget,
        submitBranchNameOverride,
        submitLinkedWorkItemProvider,
        submitStartupPrompt,
        submitShouldRunIssueAutomation
      }
    },
    [
      agentPrompt,
      attachmentPaths,
      baseBranch,
      branchNameOverride,
      effectiveLinkedPR,
      enableIssueAutomation,
      fallbackCreatureName,
      hasLoadedIssueCommand,
      issueCommandTemplate,
      linkedGitLabMR,
      linkedWorkItem,
      isExplicitWorkspaceNameInput,
      name,
      parsedLinkedIssueNumber,
      pushTarget,
      resolveSmartGitHubCreateNames,
      workspaceSeedName,
      compareBaseRef,
      lastAutoNameRef
    ]
  )

  return {
    prepareFullSubmitSource
  }
}
