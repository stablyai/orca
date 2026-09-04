import { translate } from '@/i18n/i18n'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'
import type { SkillUsageExample } from './skill-usage-example'

export const getOrchestrationUsageExamples = createLocalizedCatalog((): SkillUsageExample[] => [
  {
    id: 'supervised-worker',
    title: translate(
      'auto.lib.orchestration.usage.examples.superviseTitle',
      'Supervise a worker to completion'
    ),
    summary: translate(
      'auto.lib.orchestration.usage.examples.superviseSummary',
      'Dispatch a task and wait for the worker to report done or escalate.'
    ),
    prompt:
      'Use /orchestration to dispatch the billing settings migration to an idle Claude agent, then wait for worker_done before starting the follow-up.'
  },
  {
    id: 'decision-gate',
    title: translate(
      'auto.lib.orchestration.usage.examples.decisionGateTitle',
      'Pause for a decision before continuing'
    ),
    summary: translate(
      'auto.lib.orchestration.usage.examples.decisionGateSummary',
      'Gate the next dispatch on your approval instead of letting agents guess.'
    ),
    prompt:
      'Use /orchestration to run this schema change and open a decision gate before dispatching the destructive migration step, so it waits for my approval.'
  },
  {
    id: 'child-sequence',
    title: translate('auto.lib.orchestration.usage.examples.bddc4c09b8', 'Run a phased workflow'),
    summary: translate(
      'auto.lib.orchestration.usage.examples.childSequenceSummary',
      'Use child agents one after another when each phase depends on the last.'
    ),
    prompt:
      'Use /orchestration to run this auth refactor in phases: plan, backend, UI, then tests. Start each child agent after the previous phase is done.'
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
    prompt:
      'Use /orchestration to split this auth refactor across parallel child agents: API contract, backend call sites, UI flow, and test gaps.'
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
    prompt:
      'Use /orchestration to split this onboarding update into smaller PRs, each in its own child worktree: setup state, settings UI, copy, and tests.'
  }
])
