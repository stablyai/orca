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
      }
    ]

    expect(gitLabPipelineJobsToPRChecks(jobs)).toEqual([
      {
        name: 'test: unit',
        status: 'completed',
        conclusion: 'failure',
        url: 'https://gitlab.com/acme/orca/-/jobs/1'
      },
      {
        name: 'deploy: deploy',
        status: 'completed',
        conclusion: 'neutral',
        url: null
      }
    ])
  })
})
