import { describe, expect, it } from 'vitest'
import {
  getGitLabPipelineNotLatestCommitSha,
  gitLabPipelineJobsToPRChecks
} from './gitlab-pipeline-checks'
import type { GitLabPipelineJob } from '../../../gitlab-types'

describe('gitLabPipelineJobsToPRChecks', () => {
  it('maps GitLab pipeline jobs into right-panel check rows', () => {
    const jobs: GitLabPipelineJob[] = [
      {
        id: 1,
        name: 'unit',
        stage: 'test',
        status: 'failed',
        webUrl: 'https://gitlab.com/acme/orca/-/jobs/1',
        duration: 12,
        startedAt: '2026-11-05T10:00:00Z',
        finishedAt: '2026-11-05T10:00:12Z'
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
        startedAt: '2026-11-05T10:00:00Z',
        completedAt: '2026-11-05T10:00:12Z',
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
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: legacy input intentionally omits a required ID.
    const jobs = [
      { id: 0, name: 'zero', stage: '', status: 'failed', webUrl: '', duration: null },
      { name: 'missing', stage: '', status: 'failed', webUrl: '', duration: null }
    ] as unknown as GitLabPipelineJob[]

    const checks = gitLabPipelineJobsToPRChecks(jobs)
    expect(checks).toHaveLength(2)
    expect(checks.map((check) => check.name)).toEqual(['zero', 'missing'])
    // Why: the runtime RPC schema requires a positive int, so a falsy id must not be forwarded.
    for (const check of checks) {
      expect(check).not.toHaveProperty('gitlabJobId')
    }
  })
})

describe('getGitLabPipelineNotLatestCommitSha', () => {
  const head = 'b'.repeat(40)
  const older = 'a'.repeat(40)
  const pipeline = { id: 7, status: 'failed' }

  it('names the commit a branch or detached MR pipeline ran on once the head moves past it', () => {
    expect(
      getGitLabPipelineNotLatestCommitSha({ ...pipeline, sha: older, ref: 'feature' }, head)
    ).toBe(older)
    expect(
      getGitLabPipelineNotLatestCommitSha(
        { ...pipeline, sha: older, ref: 'refs/merge-requests/7/head' },
        head
      )
    ).toBe(older)
    expect(
      getGitLabPipelineNotLatestCommitSha({ ...pipeline, sha: head, ref: 'feature' }, head)
    ).toBeUndefined()
  })

  it('claims nothing for merge-commit pipelines or when either commit is unknown', () => {
    for (const ref of ['refs/merge-requests/7/merge', 'refs/merge-requests/7/train']) {
      expect(
        getGitLabPipelineNotLatestCommitSha({ ...pipeline, sha: older, ref }, head)
      ).toBeUndefined()
    }
    expect(
      getGitLabPipelineNotLatestCommitSha({ ...pipeline, ref: 'feature' }, head)
    ).toBeUndefined()
    expect(
      getGitLabPipelineNotLatestCommitSha({ ...pipeline, sha: older, ref: 'feature' }, undefined)
    ).toBeUndefined()
  })
})
