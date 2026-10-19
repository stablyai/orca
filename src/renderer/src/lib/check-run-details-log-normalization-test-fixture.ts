import type { PRCheckJob, PRCheckRunDetails } from '../../../shared/github/check-types'
import { createCheckLogFixture } from '../../../../config/scripts/check-job-log-test-fixture.mjs'

const captured = createCheckLogFixture()

export { captured }

export function checkLogJob(logTail: string | null, id = 1): PRCheckJob {
  return {
    id,
    name: `job-${id}`,
    status: 'completed',
    conclusion: 'failure',
    startedAt: '2026-10-10T00:00:00Z',
    completedAt: '2026-10-10T00:01:00Z',
    url: 'https://github.example.com/actions/jobs/1',
    logTail,
    steps: [
      {
        name: 'Test shard',
        status: 'completed',
        conclusion: 'failure',
        startedAt: null,
        completedAt: null
      }
    ]
  }
}

export function checkLogDetails(jobs: PRCheckJob[]): PRCheckRunDetails {
  return {
    name: 'fork-build',
    status: 'completed',
    conclusion: 'failure',
    url: 'https://github.example.com/actions/runs/456',
    detailsUrl: 'https://github.example.com/checks/123',
    startedAt: '2026-10-10T00:00:00Z',
    completedAt: '2026-10-10T00:01:00Z',
    title: 'Synthetic result',
    summary: 'Provider summary',
    text: 'Provider output',
    annotations: [
      {
        path: 'src/file.ts',
        startLine: 1,
        endLine: 2,
        annotationLevel: 'failure',
        title: 'Failure',
        message: 'Provider annotation',
        rawDetails: null
      }
    ],
    jobs
  }
}

export const legacyControls =
  '\x1b[31mEr\x1b[0mror: missing Copy\r\n\t at file.ts:18:8\r' +
  '\x1b]8;;https://example.com\x07link\x1b]8;;\x1b\\ ' +
  '\x1bPdiscard\x1b\\\x1b_discard\x1b\\\x1b^discard\x1b\\\x1bXdiscard\x1b\\' +
  '\x90discard\x9c\x98discard\x9c\x9ediscard\x9c\x9fdiscard\x9c' +
  '\x9b31mtext\x9b0m\x9dtitle\x07\x00\x01\x08\x0b\x0c\x1f\x7f\x85\n'
export const expectedLegacyControls = 'Error: missing Copy\n\t at file.ts:18:8\nlink text\n'

export function mixedCheckLogDetails(): PRCheckRunDetails {
  const jobs = [
    checkLogJob(legacyControls),
    { ...checkLogJob(captured.rawLog, 2), logState: 'available' as const },
    { ...checkLogJob('', 3), logState: 'empty' as const },
    { ...checkLogJob('contradictory\x1b[31m error tail\x1b[0m', 4), logState: 'error' as const },
    { ...checkLogJob(null, 5), logState: 'not_requested' as const },
    checkLogJob(null, 6)
  ]
  Object.assign(jobs[0], { futureJob: { attempt: 2 } })
  const details = checkLogDetails(jobs)
  Object.assign(details, { futureDetails: { version: 3 } })
  for (const job of jobs) {
    job.steps.forEach(Object.freeze)
    Object.freeze(job.steps)
    Object.freeze(job)
  }
  details.annotations.forEach(Object.freeze)
  Object.freeze(details.annotations)
  Object.freeze(jobs)
  Object.freeze(details)
  return details
}
