// Per-step copy for the review tile in the Explore Orca modal. Mirrors
// agents-orchestration-steps.ts and workbench-steps.ts so the rail / body
// code can render all three the same way.

export type ReviewStepId = 'notes' | 'pr-view' | 'ship'

export type ReviewStepBullet =
  | string
  | {
      readonly leadIn: string
      readonly body: string
    }

export type ReviewStep = {
  readonly id: ReviewStepId
  readonly name: string
  readonly subtitle: string
  readonly description: string
  readonly bulletsLeadIn?: string
  readonly bullets: readonly ReviewStepBullet[]
}

export const REVIEW_STEPS: readonly ReviewStep[] = [
  {
    id: 'notes',
    name: 'Notes',
    subtitle: 'Notes & diffs',
    description:
      'Review code diffs, leave notes on the exact lines that need attention, and send them to any agent in one click.',
    bullets: [
      {
        leadIn: 'Easily review code changes.',
        body: 'Scan changed files in a compact inline diff without jumping between tools.'
      },
      {
        leadIn: 'Write notes and send them to AI.',
        body: 'Comment on modified lines, collect the notes, and send them to Claude, Codex, or any connected AI agent as one focused set of instructions.'
      }
    ]
  },
  {
    id: 'pr-view',
    name: 'PR checks',
    subtitle: 'PR checks & comments',
    description:
      'Open the Checks tab on the right sidebar to see PR details, CI, comments, conflicts, and merge readiness in one place.',
    bullets: [
      {
        leadIn: 'Know the PR state.',
        body: 'See title, number, status, readiness, and conflicts at a glance.'
      },
      {
        leadIn: 'Track CI.',
        body: 'Scan check results and open full logs when needed.'
      },
      {
        leadIn: 'Read comments.',
        body: 'View PR comments and inline threads, including resolved and bot feedback.'
      }
    ]
  },
  {
    id: 'ship',
    name: 'Ship with AI',
    subtitle: 'Ship with AI',
    description:
      'Let AI write your commit message and pull request from the diff — both fully editable before they go out.',
    bullets: [
      'Generate a commit message from the staged diff with one click.',
      'Open a PR with an AI-written title and description, ready to edit.',
      'Keep both generated drafts editable before anything is submitted.'
    ]
  }
] as const

export function getReviewSteps(): readonly ReviewStep[] {
  return REVIEW_STEPS
}
