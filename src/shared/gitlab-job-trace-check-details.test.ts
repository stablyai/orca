import { describe, expect, it } from 'vitest'
import { gitLabJobTraceToCheckRunDetails } from './gitlab-job-trace-check-details'
import type { PRCheckDetail } from './types'

const CHECK: PRCheckDetail = {
  name: 'test: unit',
  status: 'completed',
  conclusion: 'failure',
  url: 'https://gitlab.com/acme/orca/-/jobs/1',
  gitlabJobId: 1
}

describe('gitLabJobTraceToCheckRunDetails', () => {
  it('adapts a trace into a single-job PRCheckRunDetails carrying the log tail', () => {
    const details = gitLabJobTraceToCheckRunDetails(CHECK, 'line 1\nERROR: boom\nline 3')

    expect(details.name).toBe('test: unit')
    expect(details.status).toBe('completed')
    expect(details.conclusion).toBe('failure')
    expect(details.url).toBe('https://gitlab.com/acme/orca/-/jobs/1')
    expect(details.detailsUrl).toBe('https://gitlab.com/acme/orca/-/jobs/1')
    expect(details.annotations).toEqual([])
    expect(details.jobs).toHaveLength(1)
    expect(details.jobs[0]).toMatchObject({
      id: 1,
      name: 'test: unit',
      logTail: 'line 1\nERROR: boom\nline 3',
      steps: []
    })
  })

  it('keeps only the trailing 200 lines of a large trace', () => {
    const trace = Array.from({ length: 500 }, (_, index) => `line ${index}`).join('\n')

    const [job] = gitLabJobTraceToCheckRunDetails(CHECK, trace).jobs
    const tailLines = job.logTail?.split('\n') ?? []

    expect(tailLines).toHaveLength(200)
    expect(tailLines[0]).toBe('line 300')
    expect(tailLines.at(-1)).toBe('line 499')
  })

  it('emits no job when the trace is empty so the panel shows its empty state', () => {
    expect(gitLabJobTraceToCheckRunDetails(CHECK, '   \n  ').jobs).toEqual([])
  })

  it('falls back to a null job id when the check has no gitlabJobId', () => {
    const { gitlabJobId: _omit, ...withoutId } = CHECK
    const [job] = gitLabJobTraceToCheckRunDetails(withoutId, 'boom').jobs

    expect(job.id).toBeNull()
  })
})
