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
    description: 'Send focused review notes to an agent.'
  },
  {
    id: 'pr-view',
    name: 'PR checks',
    subtitle: 'PR checks & comments',
    description: 'See PR status in the Checks tab.'
  },
  {
    id: 'ship',
    name: 'Ship with AI',
    subtitle: 'Ship with AI',
    description: 'Let AI prepare commit and PR drafts for you.'
  }
] as const

export function getReviewSteps(): readonly ReviewStep[] {
  return REVIEW_STEPS
}
