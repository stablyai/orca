// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import type { SetStateAction } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import type { PRComment } from '../../../../../../shared/github/comments/comment-types'
import type { Repo } from '../../../../../../shared/repo-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { useChecksPanelCommentMutations } from './use-checks-panel-comment-mutations'

const mocks = vi.hoisted(() => ({
  toastError: vi.fn(),
  callRuntimeRpc: vi.fn(),
  updateIssueCommentBySlug: vi.fn(),
  deleteIssueCommentBySlug: vi.fn()
}))
vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({
  callRuntimeRpc: mocks.callRuntimeRpc
}))

type Input = Parameters<typeof useChecksPanelCommentMutations>[0]

const COMMENT: PRComment = {
  id: 9001,
  author: 'octocat',
  authorAvatarUrl: '',
  body: 'old body',
  createdAt: '2026-10-30T00:00:00Z',
  url: 'https://ghe.example.com/acme/app/pull/7#issuecomment-9001'
}

function repoRow(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 'repo-1',
    path: '/work/app',
    displayName: 'app',
    badgeColor: '#000',
    addedAt: 0,
    ...overrides
  }
}

function render(args: { repo: Repo; worktree?: Partial<Worktree> }) {
  let comments: PRComment[] = [COMMENT, { ...COMMENT, id: 9002, body: 'other' }]
  let currentKey: string | null = null
  const setComments = (next: SetStateAction<PRComment[]>): void => {
    comments = typeof next === 'function' ? next(comments) : next
  }
  const model: Input = {
    activeWorktree: makeWorktree({ id: 'wt-1', repoId: args.repo.id, ...args.worktree }),
    addPRConversationComment: vi.fn(),
    addPRReviewCommentReply: vi.fn(),
    branch: 'feature',
    commentsDisabledReason: undefined,
    commentsRef: { current: comments },
    confirm: vi.fn().mockResolvedValue(true),
    isCurrentAsyncResult: (key: string) => {
      currentKey ??= key
      return key === currentKey
    },
    pr: {
      number: 7,
      title: 'Feature',
      state: 'open',
      url: 'https://ghe.example.com/acme/app/pull/7',
      checksStatus: 'pending',
      updatedAt: '2026-10-30T00:00:00Z',
      mergeable: 'UNKNOWN',
      headSha: 'abc',
      prRepo: { owner: 'acme', repo: 'app', host: 'ghe.example.com' }
    },
    prCacheKey: 'pr-cache',
    prNumber: 7,
    repo: args.repo,
    setComments,
    setPRCommentReaction: vi.fn()
  }
  const hook = renderHook(() => useChecksPanelCommentMutations(model))
  return {
    hook,
    comments: () => comments,
    // Simulates the panel moving to another PR/workspace while a request is in flight.
    moveAway: () => {
      currentKey = 'another-review'
    }
  }
}

const SERVER_EDIT_ARGS = {
  owner: 'acme',
  repo: 'app',
  host: 'ghe.example.com',
  commentId: 9001,
  body: 'new body'
}

beforeEach(() => {
  mocks.toastError.mockReset()
  mocks.callRuntimeRpc.mockReset().mockResolvedValue({ ok: true })
  mocks.updateIssueCommentBySlug.mockReset().mockResolvedValue({ ok: true })
  mocks.deleteIssueCommentBySlug.mockReset().mockResolvedValue({ ok: true })
  vi.stubGlobal('window', {
    ...window,
    api: {
      gh: {
        updateIssueCommentBySlug: mocks.updateIssueCommentBySlug,
        deleteIssueCommentBySlug: mocks.deleteIssueCommentBySlug
      }
    }
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('Checks comment edit/delete ownership', () => {
  it.each([
    ['a local repo', repoRow(), {}],
    [
      'a direct SSH workspace',
      repoRow({ connectionId: 'devbox', executionHostId: 'ssh:devbox' }),
      { hostId: 'ssh:devbox' as const }
    ]
  ])('edits %s with this computer’s credentials', async (_label, repo, worktree) => {
    const { hook, comments } = render({ repo, worktree })

    await act(async () => {
      await expect(hook.result.current.handleEditComment(COMMENT, 'new body')).resolves.toBe(true)
    })

    expect(mocks.updateIssueCommentBySlug).toHaveBeenCalledWith({
      ...SERVER_EDIT_ARGS,
      wakeWslDistro: true
    })
    expect(mocks.callRuntimeRpc).not.toHaveBeenCalled()
    expect(comments().map((c) => c.body)).toEqual(['new body', 'other'])
  })

  it.each([
    ['a server-owned repo', repoRow({ executionHostId: 'runtime:owner-server' }), {}],
    [
      'an SSH workspace behind a paired server',
      repoRow({ connectionId: 'devbox', executionHostId: 'runtime:owner-server' }),
      { hostId: 'ssh:devbox' as const, runtimeOwnerEnvironmentId: 'owner-server' }
    ]
  ])('edits %s on the owning server', async (_label, repo, worktree) => {
    const { hook, comments } = render({ repo, worktree })

    await act(async () => {
      await expect(hook.result.current.handleEditComment(COMMENT, 'new body')).resolves.toBe(true)
    })

    expect(mocks.callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'owner-server' },
      'github.project.updateIssueCommentBySlug',
      SERVER_EDIT_ARGS,
      { timeoutMs: 30_000 }
    )
    expect(mocks.updateIssueCommentBySlug).not.toHaveBeenCalled()
    expect(comments().map((c) => c.body)).toEqual(['new body', 'other'])
  })

  it('routes same-id, same-path repo copies to their own owners', async () => {
    const sshCopy = render({
      repo: repoRow({ connectionId: 'devbox', executionHostId: 'ssh:devbox' }),
      worktree: { hostId: 'ssh:devbox' }
    })
    const serverCopy = render({ repo: repoRow({ executionHostId: 'runtime:owner-server' }) })

    await act(async () => {
      await sshCopy.hook.result.current.handleDeleteComment(COMMENT)
      await serverCopy.hook.result.current.handleDeleteComment(COMMENT)
    })

    expect(mocks.deleteIssueCommentBySlug).toHaveBeenCalledTimes(1)
    expect(mocks.callRuntimeRpc).toHaveBeenCalledTimes(1)
    expect(mocks.callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'owner-server' },
      'github.project.deleteIssueCommentBySlug',
      { owner: 'acme', repo: 'app', host: 'ghe.example.com', commentId: 9001 },
      { timeoutMs: 30_000 }
    )
    expect(sshCopy.comments().map((c) => c.id)).toEqual([9002])
    expect(serverCopy.comments().map((c) => c.id)).toEqual([9002])
  })

  it('refuses an unresolvable owner instead of using this computer’s credentials', async () => {
    const { hook, comments } = render({
      repo: repoRow({ executionHostId: 'runtime:unresolved-owner' })
    })

    await act(async () => {
      await expect(hook.result.current.handleEditComment(COMMENT, 'new body')).resolves.toBe(false)
      await hook.result.current.handleDeleteComment(COMMENT)
    })

    expect(mocks.updateIssueCommentBySlug).not.toHaveBeenCalled()
    expect(mocks.deleteIssueCommentBySlug).not.toHaveBeenCalled()
    expect(mocks.callRuntimeRpc).not.toHaveBeenCalled()
    expect(mocks.toastError).toHaveBeenCalledTimes(2)
    expect(mocks.toastError).toHaveBeenCalledWith(
      expect.stringContaining('The machine that owns this repository is not known yet')
    )
    expect(comments().map((c) => c.body)).toEqual(['old body', 'other'])
  })

  it('refuses a repo row that does not own the workspace instead of guessing', async () => {
    const { hook, comments } = render({
      repo: repoRow({ connectionId: 'devbox', executionHostId: 'ssh:devbox' }),
      worktree: { hostId: 'ssh:devbox', runtimeOwnerEnvironmentId: 'owner-server' }
    })

    await act(async () => {
      await expect(hook.result.current.handleEditComment(COMMENT, 'new body')).resolves.toBe(false)
      await expect(hook.result.current.handleDeleteComment(COMMENT)).resolves.toBeUndefined()
    })

    expect(mocks.updateIssueCommentBySlug).not.toHaveBeenCalled()
    expect(mocks.deleteIssueCommentBySlug).not.toHaveBeenCalled()
    expect(mocks.callRuntimeRpc).not.toHaveBeenCalled()
    expect(mocks.toastError).toHaveBeenCalledTimes(2)
    expect(comments().map((c) => c.body)).toEqual(['old body', 'other'])
  })

  it('keeps the comment and reports when the owning server cannot run the operation', async () => {
    mocks.callRuntimeRpc.mockRejectedValue(
      Object.assign(new Error('Unknown method: github.project.deleteIssueCommentBySlug'), {
        code: 'method_not_found'
      })
    )
    const { hook, comments } = render({
      repo: repoRow({ executionHostId: 'runtime:owner-server' })
    })

    await act(() => hook.result.current.handleDeleteComment(COMMENT))

    expect(mocks.deleteIssueCommentBySlug).not.toHaveBeenCalled()
    expect(mocks.toastError).toHaveBeenCalledWith(
      'Unknown method: github.project.deleteIssueCommentBySlug'
    )
    expect(comments().map((c) => c.id)).toEqual([9001, 9002])
  })
})
