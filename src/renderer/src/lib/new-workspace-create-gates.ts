export type ComposerCreateGateInput = {
  repoId: string
  workspaceSeedName: string
  creating: boolean
  shouldWaitForSetupCheck: boolean
  shouldWaitForIssueAutomationCheck: boolean
  requiresExplicitSetupChoice: boolean
  hasSetupDecision: boolean
  sparseError: string | null
}

function hasBlockingCreateState(input: ComposerCreateGateInput): boolean {
  return (
    !input.repoId ||
    !input.workspaceSeedName ||
    input.creating ||
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
  // Why: Cmd/Ctrl+N quick create can resolve setup hooks inside the submit
  // handler, and it never runs issue-command automation. Keeping those
  // background probes out of the disabled gate makes the primary action usable
  // as soon as the form has enough local state to submit.
  return hasBlockingCreateState(input)
}
