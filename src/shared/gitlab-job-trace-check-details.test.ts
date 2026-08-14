import { describe, expect, it } from 'vitest'
import {
  gitLabJobCanHaveTrace,
  gitLabJobTraceToCheckRunDetails
} from './gitlab-job-trace-check-details'
import { gitLabPipelineJobsToPRChecks } from './gitlab-pipeline-checks'
import type { GitLabPipelineJob } from './gitlab-types'
import type { PRCheckDetail } from './github/check-types'

const STRINGS = { emptyTrace: 'No log is available for this GitLab job.' }

const failedJob: PRCheckDetail = {
  name: 'Component Tests: Purchase API',
  status: 'completed',
  conclusion: 'failure',
  url: 'https://gitlab.example.test/acme/orca/-/jobs/42',
  gitlabJobId: 42
}

describe('gitLabJobTraceToCheckRunDetails', () => {
  it('renders the trace as a single job log tail', () => {
    const details = gitLabJobTraceToCheckRunDetails(
      failedJob,
      'FAIL src/purchase/refund.spec.ts\nERROR: Job failed: exit code 1',
      STRINGS
    )

    expect(details.jobs).toHaveLength(1)
    expect(details.jobs[0]?.id).toBe(42)
    expect(details.jobs[0]?.conclusion).toBe('failure')
    expect(details.jobs[0]?.logTail).toContain('ERROR: Job failed: exit code 1')
    expect(details.summary).toBeNull()
  })

  it('copies status and conclusion from the row so the poll cache is not evicted', () => {
    const details = gitLabJobTraceToCheckRunDetails(failedJob, 'boom', STRINGS)

    expect(details.status).toBe(failedJob.status)
    expect(details.conclusion).toBe(failedJob.conclusion)
  })

  it('explains an empty trace instead of falling back to "no inline details"', () => {
    const manualJob: PRCheckDetail = {
      name: 'deploy: production',
      status: 'completed',
      conclusion: 'neutral',
      url: null,
      gitlabJobId: 77
    }

    const details = gitLabJobTraceToCheckRunDetails(manualJob, '', STRINGS)

    expect(details.jobs).toEqual([])
    expect(details.summary).toBe(STRINGS.emptyTrace)
  })

  it('re-slices a raw trace from an older remote runtime that ignored logExcerpt', () => {
    const raw = Array.from({ length: 5_000 }, (_, index) => `line ${index}`).join('\n')

    const details = gitLabJobTraceToCheckRunDetails(failedJob, raw, STRINGS)

    expect(details.jobs[0]?.logTail).toContain('line 4999')
    expect(details.jobs[0]?.logTail).not.toContain('line 0\n')
  })
})

describe('gitLabJobCanHaveTrace', () => {
  // Why: GitLab answers 404 for a job that never ran, so skip the round trip. Jobs that
  // may have run are still asked; main turns a missing log into an empty trace.
  const cases: { status: string; expected: boolean }[] = [
    { status: 'failed', expected: true },
    { status: 'success', expected: true },
    { status: 'running', expected: true },
    { status: 'canceled', expected: true },
    { status: 'created', expected: false },
    { status: 'pending', expected: false },
    { status: 'scheduled', expected: false },
    { status: 'manual', expected: false },
    { status: 'skipped', expected: false }
  ]

  for (const { status, expected } of cases) {
    it(`${expected ? 'requests' : 'skips'} a trace for a ${status} job`, () => {
      const job = {
        id: 5,
        name: 'unit',
        stage: 'test',
        status,
        webUrl: '',
        duration: null
      } as unknown as GitLabPipelineJob
      const [check] = gitLabPipelineJobsToPRChecks([job])

      expect(gitLabJobCanHaveTrace(check)).toBe(expected)
    })
  }
})
