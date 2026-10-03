// @vitest-environment happy-dom
import { cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import {
  resetDetectedReviewProvidersForTest,
  useWorktreeReviewProvider
} from './use-worktree-review-provider'

const initialState = useAppStore.getInitialState()
type GetEligibility = ReturnType<typeof useAppStore.getState>['getHostedReviewCreationEligibility']
type Eligibility = Awaited<ReturnType<GetEligibility>>
const getEligibility = vi.fn<GetEligibility>()

/** Only `provider` is read by the hook; the rest satisfies the wire type. */
function eligibility(provider: Eligibility['provider']): Eligibility {
  return {
    provider,
    review: null,
    canCreate: true,
    blockedReason: null,
    nextAction: null,
    reviewLookupOutcome: 'not_found'
  }
}
const repo: Repo = { id: 'r1', path: '/repo', displayName: 'orca', badgeColor: '#999', addedAt: 1 }

function remoteIdentity(remoteUrl: string): NonNullable<Repo['gitRemoteIdentity']> {
  return { canonicalKey: remoteUrl, remoteName: 'origin', remoteUrl }
}

function wt(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: 'r1::/repo/wt',
    repoId: 'r1',
    path: '/repo/wt',
    displayName: 'wt',
    branch: 'feature',
    head: 'abc',
    isBare: false,
    isMainWorktree: false,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 1,
    ...overrides
  }
}

function render(args: Partial<Parameters<typeof useWorktreeReviewProvider>[0]> = {}) {
  return renderHook(() =>
    useWorktreeReviewProvider({
      isOpen: true,
      isFolderWorkspace: false,
      modalReviewProvider: undefined,
      executionHostId: undefined,
      worktree: wt(),
      ...args
    })
  )
}

describe('useWorktreeReviewProvider', () => {
  beforeEach(() => {
    useAppStore.setState(initialState, true)
    getEligibility.mockReset()
    resetDetectedReviewProvidersForTest()
    useAppStore.setState({
      repos: [repo],
      getHostedReviewCreationEligibility: getEligibility
    })
  })
  // Why: a hook left mounted re-runs its effect on the next test's store write
  // and fires a detection call that test never asked for.
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('reads gitlab from a linked MR with no modalData flag, and does not detect', () => {
    const { result } = render({ worktree: wt({ linkedGitLabMR: 77 }) })
    expect(result.current.provider).toBe('gitlab')
    expect(result.current.persistedReview).toBe('77')
    expect(result.current.isResolving).toBe(false)
    expect(getEligibility).not.toHaveBeenCalled()
  })

  it('reads github from a linked PR', () => {
    const { result } = render({ worktree: wt({ linkedPR: 12 }) })
    expect(result.current.provider).toBe('github')
    expect(result.current.persistedReview).toBe('12')
  })

  it('reads a read-only provider from its own slot', () => {
    const { result } = render({ worktree: wt({ linkedBitbucketPR: 4 }) })
    expect(result.current.provider).toBe('bitbucket')
    expect(result.current.persistedReview).toBe('4')
  })

  it('lets an explicit modalData provider win over the linked slots', () => {
    const { result } = render({
      worktree: wt({ linkedGitLabMR: 77 }),
      modalReviewProvider: 'github'
    })
    expect(result.current.provider).toBe('github')
    expect(result.current.persistedReview).toBe('')
  })

  // Why: the regression this hook exists to prevent. The Checks panel's GitLab
  // call site names 'gitlab' on a workspace that may also carry a stale linkedPR.
  // A display-precedence selector would answer '' here, the snapshot baseline
  // would be empty against a seeded 77, and a comment-only save would re-emit it.
  it('reads the resolved provider slot, not the precedence winner', () => {
    const { result } = render({
      worktree: wt({ linkedPR: 5, linkedGitLabMR: 77 }),
      modalReviewProvider: 'gitlab'
    })
    expect(result.current.provider).toBe('gitlab')
    expect(result.current.persistedReview).toBe('77')
  })

  it('infers github from a github.com remote without detecting', () => {
    useAppStore.setState({
      repos: [{ ...repo, gitRemoteIdentity: remoteIdentity('https://github.com/o/r.git') }]
    })
    const { result } = render()
    expect(result.current.provider).toBe('github')
    expect(getEligibility).not.toHaveBeenCalled()
  })

  it('infers gitlab from a gitlab.com remote without detecting', () => {
    useAppStore.setState({
      repos: [{ ...repo, gitRemoteIdentity: remoteIdentity('https://gitlab.com/g/p.git') }]
    })
    const { result } = render()
    expect(result.current.provider).toBe('gitlab')
    expect(getEligibility).not.toHaveBeenCalled()
  })

  it('is unknown, never github, while detection is in flight', async () => {
    let settle: (value: Eligibility) => void = () => {}
    getEligibility.mockReturnValueOnce(
      new Promise((resolve) => {
        settle = resolve
      })
    )
    const { result } = render()
    expect(result.current.provider).toBeNull()
    expect(result.current.isResolving).toBe(true)
    settle(eligibility('gitlab'))
    await waitFor(() => expect(result.current.provider).toBe('gitlab'))
    expect(result.current.isResolving).toBe(false)
  })

  it('settles on github when detection rejects, and retries on the next open', async () => {
    getEligibility.mockRejectedValueOnce(new Error('no forge auth'))
    const first = render()
    await waitFor(() => expect(first.result.current.provider).toBe('github'))
    expect(first.result.current.isResolving).toBe(false)
    first.unmount()

    // Why: a timeout or an unauthenticated glab is not evidence about the repo.
    // Remembering it would pin a GitLab repo to a GitHub field for the session.
    getEligibility.mockResolvedValueOnce(eligibility('gitlab'))
    const second = render()
    await waitFor(() => expect(second.result.current.provider).toBe('gitlab'))
    expect(getEligibility).toHaveBeenCalledTimes(2)
  })

  it('settles on github for an unsupported answer, and does not remember it', async () => {
    getEligibility.mockResolvedValueOnce(eligibility('unsupported'))
    const first = render()
    await waitFor(() => expect(first.result.current.provider).toBe('github'))
    first.unmount()
    getEligibility.mockResolvedValueOnce(eligibility('gitlab'))
    const second = render()
    await waitFor(() => expect(second.result.current.provider).toBe('gitlab'))
  })

  it('remembers a detected answer per repo so reopening never flashes', async () => {
    getEligibility.mockResolvedValueOnce(eligibility('gitlab'))
    const first = render()
    await waitFor(() => expect(first.result.current.provider).toBe('gitlab'))
    first.unmount()
    const second = render()
    await waitFor(() => expect(second.result.current.provider).toBe('gitlab'))
    expect(second.result.current.isResolving).toBe(false)
    expect(getEligibility).toHaveBeenCalledTimes(1)
  })

  it('keys the memo per execution host, not per bare repo id', async () => {
    useAppStore.setState({
      repos: [
        { ...repo, executionHostId: 'local' },
        { ...repo, path: '/ssh/repo', executionHostId: 'ssh:box' }
      ]
    })
    getEligibility.mockResolvedValueOnce(eligibility('gitlab'))
    const local = render({ executionHostId: 'local' })
    await waitFor(() => expect(local.result.current.provider).toBe('gitlab'))
    local.unmount()

    getEligibility.mockResolvedValueOnce(eligibility('github'))
    const remote = render({ executionHostId: 'ssh:box' })
    await waitFor(() => expect(remote.result.current.provider).toBe('github'))
    expect(getEligibility).toHaveBeenCalledTimes(2)
    expect(getEligibility.mock.calls[1]?.[0]?.repoPath).toBe('/ssh/repo')
  })

  // Why: a missed repo lookup must be terminal. Leaving `provider` null forever
  // renders a permanently disabled field under "checking..." with nothing checking.
  it('falls back to github when the repo cannot be resolved', () => {
    useAppStore.setState({ repos: [] })
    const { result } = render()
    expect(result.current.provider).toBe('github')
    expect(result.current.isResolving).toBe(false)
    expect(getEligibility).not.toHaveBeenCalled()
  })

  it('never detects for a folder workspace', () => {
    const { result } = render({ isFolderWorkspace: true })
    expect(result.current.provider).toBe('github')
    expect(result.current.isResolving).toBe(false)
    expect(getEligibility).not.toHaveBeenCalled()
  })

  it('never detects while the dialog is closed', () => {
    render({ isOpen: false })
    expect(getEligibility).not.toHaveBeenCalled()
  })
})
