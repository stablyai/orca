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

  it('omits gitlabJobId when the job has no id', () => {
    const [row] = gitLabPipelineJobsToPRChecks([
      {
        id: 0,
        name: 'orphan',
        stage: '',
        status: 'success',
        webUrl: '',
        duration: null
      }
    ])

    expect(row).toEqual({
      name: 'orphan',
      status: 'completed',
      conclusion: 'success',
      url: null
    })
    expect(row).not.toHaveProperty('gitlabJobId')
  })
})
