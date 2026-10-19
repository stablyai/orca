import { beforeEach, describe, expect, it } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import {
  createTestStore,
  makePR,
  makePRRefreshWorktree,
  mockApi
} from '../slices/github-slice-test-harness'
import { isStaleMergedGitHubReviewForHead } from '../slices/hosted-review-cache-state'
import { hostedReviewInfoFromGitHubPRInfo } from '../../../../shared/hosted-review-github'
import { buildPRRefreshCandidate } from './worktree-refresh'
import { findLinkedGitHubPRRepository, getLinkedGitHubPRRepository } from './linked-pr-repository'

const FRONTEND_URL = 'https://github.com/relayto/relayto-frontend/pull/2383'
const FRONTEND = { owner: 'relayto', repo: 'relayto-frontend' }

const repo: Repo = {
  id: 'repo-1',
  path: '/docker',
  displayName: 'relayto-docker',
  badgeColor: '#000',
  addedAt: 0,
  gitRemoteIdentity: {
    canonicalKey: 'github.com/relayto/relayto-docker',
    remoteName: 'origin',
    remoteUrl: 'git@github.com:relayto/relayto-docker.git'
  }
}

function linkedRow(url: string | undefined, overrides: Partial<Worktree> = {}): Worktree {
  return makePRRefreshWorktree({
    repoId: repo.id,
    branch: 'refs/heads/main',
    linkedPR: 2383,
    linkedItems: [{ provider: 'github', type: 'pr', number: 2383, ...(url ? { url } : {}) }],
    ...overrides
  })
}

describe('getLinkedGitHubPRRepository', () => {
  it.each([
    ['a PR URL in another repository', FRONTEND_URL, repo, FRONTEND],
    [
      'an Enterprise PR URL, keeping its host',
      'https://ghe.example.com/relayto/relayto-frontend/pull/2383',
      repo,
      { ...FRONTEND, host: 'ghe.example.com' }
    ],
    ['a bare number (legacy and same-repo links)', undefined, repo, null],
    [
      'a PR URL in the row repository',
      'https://github.com/relayto/relayto-docker/pull/2383',
      repo,
      null
    ],
    [
      'a PR URL in the fork parent',
      'https://github.com/upstream/relayto-docker/pull/2383',
      { ...repo, upstream: { owner: 'upstream', repo: 'relayto-docker', host: 'github.com' } },
      null
    ],
    // Without a probed remote the host decides against its own remotes.
    ['an unprobed repository', FRONTEND_URL, { ...repo, gitRemoteIdentity: null }, FRONTEND]
  ])('%s', (_label, url, rowRepo, expected) => {
    expect(getLinkedGitHubPRRepository(linkedRow(url), rowRepo)).toEqual(expected)
  })

  it('reads only the selected PR, never other linked references', () => {
    const row = linkedRow(FRONTEND_URL, {
      linkedPR: 11,
      linkedItems: [
        { provider: 'github', type: 'pr', number: 11 },
        { provider: 'github', type: 'pr', number: 2383, url: FRONTEND_URL }
      ]
    })
    expect(getLinkedGitHubPRRepository(row, repo)).toBeNull()
    expect(getLinkedGitHubPRRepository({ ...row, linkedPR: null }, repo)).toBeNull()
  })

  it('finds the row by branch, refusing ambiguous detached rows', () => {
    const state = { worktreesByRepo: { [repo.id]: [linkedRow(FRONTEND_URL)] } }
    expect(findLinkedGitHubPRRepository(state, repo, 'main', 2383)).toEqual(FRONTEND)
    expect(findLinkedGitHubPRRepository(state, repo, 'main', 7)).toBeNull()
    const detached = { ...linkedRow(FRONTEND_URL), branch: '' }
    expect(
      findLinkedGitHubPRRepository(
        { worktreesByRepo: { [repo.id]: [detached, { ...detached, id: 'other' }] } },
        repo,
        '',
        2383
      )
    ).toBeNull()
  })
})

describe('cross-repository PR links in renderer refreshes', () => {
  const store = createTestStore()

  beforeEach(() => {
    mockApi.hostedReview.forBranch.mockReset().mockResolvedValue(null)
    store.setState({
      repos: [repo],
      worktreesByRepo: { [repo.id]: [linkedRow(FRONTEND_URL)] },
      hostedReviewCache: {},
      prCache: {},
      settings: null
    })
  })

  it('PR refresh candidates name the linked repository only for other repositories', () => {
    expect(
      buildPRRefreshCandidate(store.getState(), linkedRow(FRONTEND_URL))?.linkedPRRepository
    ).toEqual(FRONTEND)
    expect(buildPRRefreshCandidate(store.getState(), linkedRow(undefined))).not.toHaveProperty(
      'linkedPRRepository'
    )
  })

  it('every branch review lookup for the row asks the linked repository', async () => {
    // Callers such as the Checks panel pass only the number; the store adds the repository.
    await store
      .getState()
      .fetchHostedReviewForBranch(repo.path, 'main', { repoId: repo.id, linkedGitHubPR: 2383 })

    expect(mockApi.hostedReview.forBranch).toHaveBeenCalledWith(
      expect.objectContaining({ linkedGitHubPR: 2383, linkedGitHubPRRepository: FRONTEND })
    )
  })

  it('same-repo lookups keep their exact request shape', async () => {
    store.setState({ worktreesByRepo: { [repo.id]: [linkedRow(undefined)] } })

    await store
      .getState()
      .fetchHostedReviewForBranch(repo.path, 'main', { repoId: repo.id, linkedGitHubPR: 2383 })

    expect(mockApi.hostedReview.forBranch.mock.calls[0]?.[0]).not.toHaveProperty(
      'linkedGitHubPRRepository'
    )
  })

  it('a merged PR from another repository stays current whatever the row HEAD is', () => {
    const entry = (linkedFromOtherRepository: boolean) => ({
      data: hostedReviewInfoFromGitHubPRInfo(
        makePR({ state: 'merged', headSha: 'pr-head', linkedFromOtherRepository })
      ),
      fetchedAt: 1
    })
    expect(isStaleMergedGitHubReviewForHead(entry(false), 'row-head')).toBe(true)
    expect(isStaleMergedGitHubReviewForHead(entry(true), 'row-head')).toBe(false)
  })
})
