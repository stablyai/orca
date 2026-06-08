export type OrchestrationUsageExample = {
  id: string
  title: string
  summary: string
  prompt: string
}

export const ORCHESTRATION_USAGE_EXAMPLES: readonly OrchestrationUsageExample[] = [
  {
    id: 'handoff',
    title: 'Hand off an active task',
    summary: 'Move ownership to another agent with enough context to continue.',
    prompt:
      'Use /orchestration to hand this billing settings task to the idle Claude agent. Include the goal, current context, and what they should finish next.'
  },
  {
    id: 'worktree-handoff',
    title: 'Hand off to another worktree',
    summary: 'Move work to an agent that is already running in a different branch.',
    prompt:
      'Use /orchestration to hand this settings cleanup to the agent in the settings-polish worktree. Send the goal, relevant files, and expected result.'
  },
  {
    id: 'child-sequence',
    title: 'Run a phased workflow',
    summary: 'Use child agents one after another when each phase depends on the last.',
    prompt:
      'Use /orchestration to run this auth refactor in phases: plan, backend, UI, then tests. Start each child agent after the previous phase is done.'
  },
  {
    id: 'child-parallel',
    title: 'Run independent work in parallel',
    summary: 'Split non-overlapping investigation or implementation tasks across child agents.',
    prompt:
      'Use /orchestration to split this auth refactor across parallel child agents: API contract, backend call sites, UI flow, and test gaps.'
  },
  {
    id: 'child-worktrees',
    title: 'Split a large change into smaller PRs',
    summary: 'Give each child agent its own worktree so parallel implementation stays reviewable.',
    prompt:
      'Use /orchestration to split this onboarding update into smaller PRs, each in its own child worktree: setup state, settings UI, copy, and tests.'
  }
]
