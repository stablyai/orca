import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GiteaWorkItemDetails } from '../../../../../shared/gitea-types'

const runtime = vi.hoisted(() => ({ call: vi.fn() }))

vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: runtime.call,
  runtimeEnvironmentSupportsCapability: vi.fn()
}))

import {
  fetchGiteaReviewDataForChecks,
  giteaPipelineJobsToPRChecks,
  giteaPRCommentsToPRComments,
  isGiteaChecksPanelReview,
  resolveGiteaPRDiscussionForChecks
} from './gitea-review-client'

const gitea = { workItemDetails: vi.fn(), resolvePRDiscussion: vi.fn(), updatePR: vi.fn() }

beforeEach(() => {
  runtime.call.mockReset()
  runtime.call.mockResolvedValue(null)
  gitea.workItemDetails.mockReset().mockResolvedValue(null)
  gitea.resolvePRDiscussion.mockReset().mockResolvedValue({ ok: true })
  gitea.updatePR.mockReset().mockResolvedValue({ ok: true })
  vi.stubGlobal('window', { api: { gitea } })
})

describe('Gitea checks-panel provider adapter', () => {
  it('reads an SSH workspace PR on this computer, never the focused server', async () => {
    await fetchGiteaReviewDataForChecks({
      repoPath: '/workspace/repo',
      repoId: 'repo-1',
      number: 17,
      repoOwnerExecutionHostId: 'ssh:devbox'
    })
    await resolveGiteaPRDiscussionForChecks({
      repoPath: '/workspace/repo',
      repoId: 'repo-1',
      number: 17,
      discussionId: 'discussion-4',
      resolved: true,
      repoOwnerExecutionHostId: 'ssh:devbox'
    })

    expect(runtime.call).not.toHaveBeenCalled()
    expect(gitea.workItemDetails).toHaveBeenCalledWith({
      repoPath: '/workspace/repo',
      repoId: 'repo-1',
      repoOwnerExecutionHostId: 'ssh:devbox',
      number: 17,
      type: 'pr',
      includeReviewDetails: false
    })
    expect(gitea.resolvePRDiscussion).toHaveBeenCalledWith({
      repoPath: '/workspace/repo',
      repoId: 'repo-1',
      number: 17,
      discussionId: 'discussion-4',
      resolved: true
    })
  })

  it('marks background polls so a stopped WSL distro is refused, not booted', async () => {
    await fetchGiteaReviewDataForChecks({ repoPath: '/repo', number: 3, background: true })
    expect(gitea.workItemDetails).toHaveBeenCalledWith(
      expect.objectContaining({ number: 3, background: true })
    )
  })

  it('returns the shared failure result when a thread cannot be resolved', async () => {
    gitea.resolvePRDiscussion.mockResolvedValue({ ok: false, error: 'forbidden' })
    await expect(
      resolveGiteaPRDiscussionForChecks({
        repoPath: '/repo',
        number: 3,
        discussionId: 'd',
        resolved: false
      })
    ).resolves.toEqual({ ok: false, error: 'forbidden' })
  })

  it('maps Actions jobs to checks and keeps log retrieval off external commit statuses', () => {
    expect(
      giteaPipelineJobsToPRChecks([
        {
          id: 11,
          runId: 2,
          name: 'build',
          stage: 'CI',
          status: 'failure',
          webUrl: 'u',
          duration: 3
        },
        { id: 12, name: 'lint', stage: '', status: 'running', webUrl: '', duration: null },
        { id: 13, name: 'queue', stage: '', status: 'waiting', webUrl: '', duration: null },
        { id: 0, name: 'ext/ci', stage: '', status: 'success', webUrl: 'x', duration: null }
      ])
    ).toEqual([
      { name: 'CI: build', status: 'completed', conclusion: 'failure', url: 'u', giteaJobId: 11 },
      { name: 'lint', status: 'in_progress', conclusion: 'pending', url: null, giteaJobId: 12 },
      { name: 'queue', status: 'queued', conclusion: 'pending', url: null, giteaJobId: 13 },
      { name: 'ext/ci', status: 'completed', conclusion: 'success', url: 'x' }
    ])
  })

  it('drops open-ended reactions so the shared comment renderer accepts Gitea comments', () => {
    const comment: GiteaWorkItemDetails['comments'][number] = {
      id: 1,
      author: 'a',
      authorAvatarUrl: '',
      body: 'hi',
      createdAt: '',
      url: '',
      threadId: 't1',
      reactions: [{ name: 'custom', count: 1 }]
    }
    expect(giteaPRCommentsToPRComments([comment])[0]).not.toHaveProperty('reactions')
    expect(giteaPRCommentsToPRComments(undefined)).toEqual([])
  })

  it('narrows a hosted review to Gitea only', () => {
    expect(isGiteaChecksPanelReview(null)).toBe(false)
  })
})
