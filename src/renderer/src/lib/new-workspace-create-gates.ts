export type ComposerCreateGateInput = {
  repoId: string
  workspaceSeedName: string
  creating: boolean
  shouldWaitForSetupCheck: boolean
  shouldWaitForIssueAutomationCheck: boolean
  sourceIntentBlocksCreate?: boolean
  requiresExplicitSetupChoice: boolean
  hasSetupDecision: boolean
  selectedRepoRequiresConnection: boolean
  sparseError: string | null
}

function hasBlockingCreateState(input: ComposerCreateGateInput): boolean {
  return (
    !input.workspaceSeedName ||
    input.sourceIntentBlocksCreate === true ||
    input.creating ||
    input.selectedRepoRequiresConnection ||
    (input.requiresExplicitSetupChoice && !input.hasSetupDecision) ||
    input.sparseError !== null
  )
}

export function getFullComposerCreateDisabled(input: ComposerCreateGateInput): boolean {
  return (
    hasBlockingCreateState(input) ||
    input.shouldWaitForSetupCheck ||
    input.shouldWaitForIssueAutomationCheck
  )
}

export function getQuickComposerCreateDisabled(input: ComposerCreateGateInput): boolean {
  // Why: quick create resolves setup hooks and optional issue automation inside submit. Keeping those
  // background probes out of the disabled gate makes the primary action usable
  // as soon as the form has enough local state to submit.
  return hasBlockingCreateState(input)
}
