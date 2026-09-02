import { translate } from '@/i18n/i18n'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'
import type { SkillUsageExample } from './skill-usage-example'

const ORCHESTRATION_SLASH_COMMAND = '/orchestration'

export const getOrchestrationUsageExamples = createLocalizedCatalog((): SkillUsageExample[] => [
  {
    id: 'handoff',
    title: translate('auto.lib.orchestration.usage.examples.5e0d489fe1', 'Hand off an active task'),
    summary: translate(
      'auto.lib.orchestration.usage.examples.handoffSummary',
      'Move ownership to another agent with enough context to continue.'
    ),
    prompt: translate(
      'auto.lib.orchestration.usage.examples.handoffPrompt',
      'Use {{value0}} to hand this billing settings task to the idle Claude agent. Include the goal, current context, and what they should finish next.',
      { value0: ORCHESTRATION_SLASH_COMMAND }
    )
  },
  {
    id: 'worktree-handoff',
    title: translate(
      'auto.lib.orchestration.usage.examples.ab0e9803b7',
      'Hand off to another worktree'
    ),
    summary: translate(
      'auto.lib.orchestration.usage.examples.worktreeHandoffSummary',
      'Move work to an agent that is already running in a different branch.'
    ),
    prompt: translate(
      'auto.lib.orchestration.usage.examples.worktreeHandoffPrompt',
      'Use {{value0}} to hand this settings cleanup to the agent in the settings-polish worktree. Send the goal, relevant files, and expected result.',
      { value0: ORCHESTRATION_SLASH_COMMAND }
    )
  },
  {
    id: 'child-sequence',
    title: translate('auto.lib.orchestration.usage.examples.bddc4c09b8', 'Run a phased workflow'),
    summary: translate(
      'auto.lib.orchestration.usage.examples.childSequenceSummary',
      'Use child agents one after another when each phase depends on the last.'
    ),
    prompt: translate(
      'auto.lib.orchestration.usage.examples.childSequencePrompt',
      'Use {{value0}} to run this auth refactor in phases: plan, backend, UI, then tests. Start each child agent after the previous phase is done.',
      { value0: ORCHESTRATION_SLASH_COMMAND }
    )
  },
  {
    id: 'child-parallel',
    title: translate(
      'auto.lib.orchestration.usage.examples.9e37a5b1b3',
      'Run independent work in parallel'
    ),
    summary: translate(
      'auto.lib.orchestration.usage.examples.childParallelSummary',
      'Split non-overlapping investigation or implementation tasks across child agents.'
    ),
    prompt: translate(
      'auto.lib.orchestration.usage.examples.childParallelPrompt',
      'Use {{value0}} to split this auth refactor across parallel child agents: API contract, backend call sites, UI flow, and test gaps.',
      { value0: ORCHESTRATION_SLASH_COMMAND }
    )
  },
  {
    id: 'child-worktrees',
    title: translate(
      'auto.lib.orchestration.usage.examples.f91fe27f2a',
      'Split a large change into smaller PRs'
    ),
    summary: translate(
      'auto.lib.orchestration.usage.examples.prSplitSummary',
      'Give each child agent its own worktree so parallel implementation stays reviewable.'
    ),
    prompt: translate(
      'auto.lib.orchestration.usage.examples.prSplitPrompt',
      'Use {{value0}} to split this onboarding update into smaller PRs, each in its own child worktree: setup state, settings UI, copy, and tests.',
      { value0: ORCHESTRATION_SLASH_COMMAND }
    )
  }
])
