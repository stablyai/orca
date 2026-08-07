import { describe, expect, it } from 'vitest'
import { gitLabPipelineJobsToPRChecks } from './gitlab-pipeline-checks'
import type { GitLabPipelineJob } from './types'

// Repro for #7732: the Checks side panel can only ask for a GitLab job trace if the mapped
// check row still carries the numeric GitLab job id (gitlab:jobTrace takes { jobId }).
function numericHandles(value: object): number[] {
  return Object.values(value).filter((v): v is number => typeof v === 'number')
}

describe('#7732 GitLab pipeline job -> check row mapping', () => {
  const failedJob: GitLabPipelineJob = {
    id: 42,
    name: 'Purchase API Component Tests',
    stage: 'Component Tests',
    status: 'failed',
    webUrl: 'https://gitlab.com/acme/orca/-/jobs/42',
    duration: 31
  }

  it('keeps the GitLab job id so the panel can fetch the job trace', () => {
    const [check] = gitLabPipelineJobsToPRChecks([failedJob])

    expect(check.name).toBe('Component Tests: Purchase API Component Tests')
    expect(check.conclusion).toBe('failure')
    // The id is the only handle gitlab:jobTrace accepts; without it the expand path has nothing to send.
    expect(numericHandles(check)).toContain(42)
  })
})
