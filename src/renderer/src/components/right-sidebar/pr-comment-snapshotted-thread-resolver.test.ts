import { describe, expect, it, vi } from 'vitest'
import {
  buildSnapshottedThreadResolver,
  type SnapshottedThreadResolverDeps
} from './pr-comment-snapshotted-thread-resolver'

const PR_REPO = { owner: 'acme', repo: 'widgets', host: 'github.com' }

function deps(
  overrides: Partial<SnapshottedThreadResolverDeps> = {}
): SnapshottedThreadResolverDeps {
  return {
    provider: 'github',
    githubResolveTarget: { repoPath: '/repos/widgets', repoId: 'repo-1', prNumber: 42 },
    resolveReviewThread: vi.fn().mockResolvedValue(true),
    resolveGitLabDiscussion: vi.fn().mockResolvedValue({ ok: true }),
    isPanelStillOnLaunchReview: () => true,
    onResolvedOptimistically: vi.fn(),
    onResolveFailed: vi.fn(),
    ...overrides
  }
}

describe('buildSnapshottedThreadResolver', () => {
  it('resolves a GitHub thread against the snapshotted PR, passing prRepo when known', async () => {
    const resolveReviewThread = vi.fn().mockResolvedValue(true)
    const onResolvedOptimistically = vi.fn()
    const resolve = buildSnapshottedThreadResolver(
      deps({
        githubResolveTarget: {
          repoPath: '/repos/widgets',
          repoId: 'repo-1',
          prNumber: 42,
          prRepo: PR_REPO
        },
        resolveReviewThread,
        onResolvedOptimistically
      })
    )

    expect(await resolve('T1')).toBe(true)
    expect(resolveReviewThread).toHaveBeenCalledWith('/repos/widgets', 42, 'T1', true, {
      repoId: 'repo-1',
      prRepo: PR_REPO
    })
    expect(onResolvedOptimistically).toHaveBeenCalledWith('T1')
  })

  // Why: resolveReviewThread takes prRepo as an option; a degraded PR entry must still resolve.
  it('resolves a GitHub thread when the snapshot has no prRepo', async () => {
    const resolveReviewThread = vi.fn().mockResolvedValue(true)
    const resolve = buildSnapshottedThreadResolver(deps({ resolveReviewThread }))

    expect(await resolve('T1')).toBe(true)
    expect(resolveReviewThread).toHaveBeenCalledWith('/repos/widgets', 42, 'T1', true, {
      repoId: 'repo-1',
      prRepo: undefined
    })
  })

  it('resolves a GitLab discussion against the snapshotted MR iid', async () => {
    const resolveGitLabDiscussion = vi.fn().mockResolvedValue({ ok: true })
    const resolveReviewThread = vi.fn()
    const resolve = buildSnapshottedThreadResolver(
      deps({
        provider: 'gitlab',
        githubResolveTarget: undefined,
        gitlabTarget: { repoPath: '/repos/widgets', repoId: 'repo-1', iid: 7 },
        resolveGitLabDiscussion,
        resolveReviewThread
      })
    )

    expect(await resolve('D1')).toBe(true)
    expect(resolveGitLabDiscussion).toHaveBeenCalledWith({
      repoPath: '/repos/widgets',
      repoId: 'repo-1',
      iid: 7,
      discussionId: 'D1',
      resolved: true
    })
    expect(resolveReviewThread).not.toHaveBeenCalled()
  })

  it('fails without calling a host when the provider cannot resolve threads', async () => {
    const resolveReviewThread = vi.fn()
    const resolveGitLabDiscussion = vi.fn()
    const onResolveFailed = vi.fn()
    const resolve = buildSnapshottedThreadResolver(
      deps({
        provider: 'bitbucket',
        githubResolveTarget: undefined,
        resolveReviewThread,
        resolveGitLabDiscussion,
        onResolveFailed
      })
    )

    expect(await resolve('T1')).toBe(false)
    expect(resolveReviewThread).not.toHaveBeenCalled()
    expect(resolveGitLabDiscussion).not.toHaveBeenCalled()
    expect(onResolveFailed).toHaveBeenCalledWith({ threadId: 'T1', error: undefined })
  })

  it('fails when the snapshotted target is missing', async () => {
    const resolveGithub = buildSnapshottedThreadResolver(deps({ githubResolveTarget: undefined }))
    const resolveGitlab = buildSnapshottedThreadResolver(
      deps({ provider: 'gitlab', githubResolveTarget: undefined, gitlabTarget: undefined })
    )

    expect(await resolveGithub('T1')).toBe(false)
    expect(await resolveGitlab('D1')).toBe(false)
  })

  it('surfaces the GitLab host error instead of swallowing it', async () => {
    const onResolveFailed = vi.fn()
    const onResolvedOptimistically = vi.fn()
    const resolve = buildSnapshottedThreadResolver(
      deps({
        provider: 'gitlab',
        githubResolveTarget: undefined,
        gitlabTarget: { repoPath: '/repos/widgets', repoId: 'repo-1', iid: 7 },
        resolveGitLabDiscussion: vi.fn().mockResolvedValue({ ok: false, error: 'timed out' }),
        onResolveFailed,
        onResolvedOptimistically
      })
    )

    expect(await resolve('D1')).toBe(false)
    expect(onResolveFailed).toHaveBeenCalledWith({ threadId: 'D1', error: 'timed out' })
    expect(onResolvedOptimistically).not.toHaveBeenCalled()
  })

  // Why: one rejected host call must not abort the bulk ack pool.
  it('reports a rejected host call as a failure', async () => {
    const onResolveFailed = vi.fn()
    const resolve = buildSnapshottedThreadResolver(
      deps({
        resolveReviewThread: vi.fn().mockRejectedValue(new Error('socket closed')),
        onResolveFailed
      })
    )

    expect(await resolve('T1')).toBe(false)
    expect(onResolveFailed).toHaveBeenCalledWith({ threadId: 'T1', error: 'socket closed' })
  })

  it('skips the optimistic update when the resolve failed', async () => {
    const onResolvedOptimistically = vi.fn()
    const resolve = buildSnapshottedThreadResolver(
      deps({
        resolveReviewThread: vi.fn().mockResolvedValue(false),
        onResolvedOptimistically
      })
    )

    expect(await resolve('T1')).toBe(false)
    expect(onResolvedOptimistically).not.toHaveBeenCalled()
  })

  // Why: the host call still belongs to the launch review, but the optimistic row would land
  // in whatever review the panel navigated to.
  it('still resolves on the host but skips the optimistic update after the panel moved', async () => {
    const resolveReviewThread = vi.fn().mockResolvedValue(true)
    const onResolvedOptimistically = vi.fn()
    const resolve = buildSnapshottedThreadResolver(
      deps({
        resolveReviewThread,
        isPanelStillOnLaunchReview: () => false,
        onResolvedOptimistically
      })
    )

    expect(await resolve('T1')).toBe(true)
    expect(resolveReviewThread).toHaveBeenCalledTimes(1)
    expect(onResolvedOptimistically).not.toHaveBeenCalled()
  })
})
