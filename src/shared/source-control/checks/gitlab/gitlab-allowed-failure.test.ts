import { expect, it } from 'vitest'
import { gitLabPipelineJobsToPRChecks } from './gitlab-pipeline-checks'
import { summarizeProviderChecks } from '../provider-check-summary'
import { gitLabJobCanHaveTrace } from './gitlab-job-trace-check-details'
it('counts only optional failed jobs as passing while preserving required and unfinished outcomes', () => {
  const jobs = [
    { status: 'failed', allowFailure: true },
    { status: 'failed', allowFailure: false },
    { status: 'running', allowFailure: true },
    { status: 'manual', allowFailure: true },
    { status: 'skipped', allowFailure: true },
    { status: 'canceled', allowFailure: true }
  ].map((job, i) => ({
    ...job,
    id: i + 1,
    name: `job-${i}`,
    stage: 'test',
    webUrl: '',
    duration: null
  }))
  const checks = gitLabPipelineJobsToPRChecks(jobs)
  expect(checks[0]).toMatchObject({
    status: 'completed',
    conclusion: 'neutral',
    gitlabAllowedFailure: true,
    gitlabJobId: 1
  })
  expect(checks.slice(1).every((c) => c.gitlabAllowedFailure === undefined)).toBe(true)
  expect(summarizeProviderChecks(checks)).toEqual({
    state: 'failure',
    total: 6,
    passed: 2,
    failed: 2,
    pending: 1,
    neutral: 1,
    cancelled: 1
  })
  expect(summarizeProviderChecks([checks[0]])).toMatchObject({
    state: 'success',
    passed: 1,
    failed: 0
  })
  expect(
    summarizeProviderChecks([
      { status: 'completed', conclusion: 'neutral' },
      { status: 'completed', conclusion: 'skipped' }
    ])
  ).toMatchObject({ passed: 1, neutral: 1 })
  expect(gitLabJobCanHaveTrace(checks[0])).toBe(true)
  expect(gitLabJobCanHaveTrace(checks[3])).toBe(false)
})
