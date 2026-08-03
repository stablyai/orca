import { describe, expect, it } from 'vitest'
import { gitLabPipelineJobsToPRChecks } from './gitlab-pipeline-checks'
import type { GitLabPipelineJob } from './types'

describe('gitLabPipelineJobsToPRChecks', () => {
  it('maps GitLab pipeline jobs into right-panel check rows', () => {
    const jobs: GitLabPipelineJob[] = [
      {
        id: 1,
        name: 'unit',
        stage: 'test',
        status: 'failed',
        webUrl: 'https://gitlab.com/acme/orca/-/jobs/1',
        duration: 12
      },
      {
        id: 2,
        name: 'deploy',
        stage: 'deploy',
        status: 'manual',
        webUrl: '',
        duration: null
      },
      {
        id: 3,
        name: 'delayed deploy',
        stage: 'deploy',
        status: 'scheduled',
        webUrl: 'https://gitlab.com/acme/orca/-/jobs/3',
        duration: null
      },
      {
        id: 4,
        name: 'external callback',
        stage: 'integration',
        status: 'waiting_for_callback',
        webUrl: 'https://gitlab.com/acme/orca/-/jobs/4',
        duration: null
      }
    ]

    expect(gitLabPipelineJobsToPRChecks(jobs)).toEqual([
      {
        name: 'test: unit',
        status: 'completed',
        conclusion: 'failure',
        url: 'https://gitlab.com/acme/orca/-/jobs/1',
        gitlabJobId: 1
      },
      {
        name: 'deploy: deploy',
        status: 'completed',
        conclusion: 'neutral',
        url: null,
        gitlabJobId: 2
      },
      {
        name: 'deploy: delayed deploy',
        status: 'queued',
        conclusion: 'pending',
        url: 'https://gitlab.com/acme/orca/-/jobs/3',
        gitlabJobId: 3
      },
      {
        name: 'integration: external callback',
        status: 'queued',
        conclusion: 'pending',
        url: 'https://gitlab.com/acme/orca/-/jobs/4',
        gitlabJobId: 4
      }
    ])
  })

  it('omits the job id when GitLab does not report a usable one', () => {
    const jobs = [
      { id: 0, name: 'zero', stage: '', status: 'failed', webUrl: '', duration: null },
      { name: 'missing', stage: '', status: 'failed', webUrl: '', duration: null }
    ] as unknown as GitLabPipelineJob[]

    // Why: the runtime RPC schema requires a positive int, so a falsy id must not be forwarded.
    for (const check of gitLabPipelineJobsToPRChecks(jobs)) {
      expect(check).not.toHaveProperty('gitlabJobId')
    }
  })
})
