// Per-step copy for the review tile in the Explore Orca modal. Mirrors
// agents-orchestration-steps.ts and workbench-steps.ts so the rail / body
// code can render all three the same way.

export type ReviewStepId = 'notes' | 'pr-view' | 'ship'

export type ReviewStep = {
  readonly id: ReviewStepId
  readonly name: string
  readonly subtitle: string
  readonly description: string
}

export const REVIEW_STEPS: readonly ReviewStep[] = [
  {
    id: 'notes',
    name: 'Notes',
    subtitle: 'Notes & diffs',
    description:
      'Review diffs, leave notes on exact changed lines, and send focused feedback back to an agent.'
  },
  {
    id: 'pr-view',
    name: 'PR checks',
    subtitle: 'PR checks & comments',
    description: 'See PR details, CI, comments, conflicts, and merge readiness from the Checks tab.'
  },
  {
    id: 'ship',
    name: 'Ship with AI',
    subtitle: 'Ship with AI',
    description:
      "Use Orca's built-in AI flow to draft commit messages and pull requests from the diff, with everything editable before submission."
  }
] as const

export function getReviewSteps(): readonly ReviewStep[] {
  return REVIEW_STEPS
}
