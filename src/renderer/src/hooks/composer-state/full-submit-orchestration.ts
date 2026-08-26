import type { ComposerModel } from './composer-model'

export type FullSubmitOrchestrationInput = Pick<
  ComposerModel,
  | 'disabledTuiAgents'
  | 'executeFullCreation'
  | 'fallbackDefaultAgent'
  | 'isProjectGroupTarget'
  | 'isSubmissionCancelled'
  | 'repoId'
  | 'requiresExplicitSetupChoice'
  | 'resolvePendingSmartGitHubSubmit'
  | 'selectedRepo'
  | 'selectedRepoRequiresConnection'
  | 'setCreateError'
  | 'setCreating'
  | 'setTuiAgent'
  | 'setupDecision'
  | 'shouldWaitForIssueAutomationCheck'
  | 'shouldWaitForSetupCheck'
  | 'showProjectRequiredError'
  | 'sourceIntentBlocksCreate'
  | 'sparseError'
  | 'submitFolderTarget'
  | 'tuiAgent'
  | 'workspaceSeedName'
>

import { useCallback } from 'react'
import { isTuiAgentEnabled } from '../../../../shared/tui-agent-selection'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { settleComposerSubmit } from '@/lib/composer-submit-cancellation'
import {
  formatWorkspaceCreateError,
  getWorkspaceCreateErrorToastMessage
} from '@/lib/workspace-create-error-format'

export function useFullSubmitOrchestration(input: FullSubmitOrchestrationInput) {
  const {
    disabledTuiAgents,
    executeFullCreation,
    fallbackDefaultAgent,
    isProjectGroupTarget,
    isSubmissionCancelled,
    repoId,
    requiresExplicitSetupChoice,
    resolvePendingSmartGitHubSubmit,
    selectedRepo,
    selectedRepoRequiresConnection,
    setCreateError,
    setCreating,
    setTuiAgent,
    setupDecision,
    shouldWaitForIssueAutomationCheck,
    shouldWaitForSetupCheck,
    showProjectRequiredError,
    sourceIntentBlocksCreate,
    sparseError,
    submitFolderTarget,
    tuiAgent,
    workspaceSeedName
  } = input

  const submit = useCallback(async (): Promise<void> => {
    if (isProjectGroupTarget) {
      await submitFolderTarget(tuiAgent)
      return
    }

    if (!repoId || !selectedRepo) {
      showProjectRequiredError()
      return
    }

    if (
      !workspaceSeedName ||
      selectedRepoRequiresConnection ||
      shouldWaitForSetupCheck ||
      shouldWaitForIssueAutomationCheck ||
      sourceIntentBlocksCreate ||
      (requiresExplicitSetupChoice && !setupDecision) ||
      sparseError !== null
    ) {
      return
    }

    if (!isTuiAgentEnabled(tuiAgent, disabledTuiAgents)) {
      setTuiAgent(fallbackDefaultAgent)
      toast.error(
        translate(
          'auto.hooks.useComposerState.7eb3f44ff7',
          'Selected agent is disabled. Choose an enabled agent before creating.'
        )
      )
      return
    }

    setCreateError(null)

    setCreating(true)
    try {
      const smartGitHubSettlement = await settleComposerSubmit(
        resolvePendingSmartGitHubSubmit(),
        isSubmissionCancelled
      )
      if (smartGitHubSettlement.status === 'cancelled') {
        return
      }
      await executeFullCreation(smartGitHubSettlement.value, repoId)
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
  }, [
    disabledTuiAgents,
    executeFullCreation,
    fallbackDefaultAgent,
    isProjectGroupTarget,
    isSubmissionCancelled,
    repoId,
    requiresExplicitSetupChoice,
    resolvePendingSmartGitHubSubmit,
    selectedRepo,
    selectedRepoRequiresConnection,
    setCreateError,
    setCreating,
    setTuiAgent,
    setupDecision,
    shouldWaitForIssueAutomationCheck,
    shouldWaitForSetupCheck,
    showProjectRequiredError,
    sourceIntentBlocksCreate,
    sparseError,
    submitFolderTarget,
    tuiAgent,
    workspaceSeedName
  ])

  return {
    submit
  }
}
