export type ComposerCreateGateInput = {
  repoId: string
  workspaceSeedName: string
  creating: boolean
  sourceIntentBlocksCreate?: boolean
  selectedRepoRequiresConnection: boolean
  selectedTargetNeedsVisibleHost: boolean
  sparseError: string | null
}

function hasBlockingCreateState(input: ComposerCreateGateInput): boolean {
  return (
    !input.workspaceSeedName ||
    input.sourceIntentBlocksCreate === true ||
    input.creating ||
    input.selectedRepoRequiresConnection ||
    input.selectedTargetNeedsVisibleHost ||
    input.sparseError !== null
  )
}

export function getQuickComposerCreateDisabled(input: ComposerCreateGateInput): boolean {
  // Setup/automation probes run during submit; keep them out of disabled gates so valid local form state remains actionable.
  return hasBlockingCreateState(input)
}
