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
import { buildPRRefreshCandidate, isStaleExactLinkedPRLookup } from './worktree-refresh'
import {
  findWorktreeRepo,
  findLinkedGitHubPRRepository,
  foundPRForLinkedRepository,
  getLinkedGitHubPRRepository,
  isCachedPRForLinkedRepository
} from './linked-pr-repository'
import {
  getHostedReviewCacheKey,
  githubPRHintKey,
  linkedReviewHintKey
} from '../slices/hosted-review-cache-identity'

const FRONTEND_URL = 'https://github.com/relayto/relayto-frontend/pull/2383'
const FRONTEND = { owner: 'relayto', repo: 'relayto-frontend' }
const API = { owner: 'relayto', repo: 'relayto-api' }

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
    const state = { repos: [repo], worktreesByRepo: { [repo.id]: [linkedRow(FRONTEND_URL)] } }
    expect(findLinkedGitHubPRRepository(state, repo, 'main', 2383)).toEqual(FRONTEND)
    expect(findLinkedGitHubPRRepository(state, repo, 'main', 7)).toBeNull()
    const detached = { ...linkedRow(FRONTEND_URL), branch: '' }
    expect(
      findLinkedGitHubPRRepository(
        { repos: [repo], worktreesByRepo: { [repo.id]: [detached, { ...detached, id: 'other' }] } },
        repo,
        '',
        2383
      )
    ).toBeNull()
  })

  it('reads only rows on the repository’s own host when one repo id spans hosts', () => {
    const local = { ...repo, executionHostId: 'local' as const }
    const remote = { ...repo, executionHostId: 'ssh:box' as const }
    const state = {
      repos: [local, remote],
      worktreesByRepo: {
        [repo.id]: [
          linkedRow(FRONTEND_URL, { id: 'local-row', hostId: 'local' }),
          linkedRow(FRONTEND_URL, { id: 'remote-row', hostId: 'ssh:box' })
        ]
      }
    }
    expect(findLinkedGitHubPRRepository(state, local, 'main', 2383)).toEqual(FRONTEND)
    expect(findLinkedGitHubPRRepository(state, remote, 'main', 2383)).toEqual(FRONTEND)
  })
})

describe('findWorktreeRepo', () => {
  const local = { ...repo, executionHostId: 'local' as const }
  const paired = { ...repo, executionHostId: 'runtime:env-1' as const, connectionId: 'target' }
  const at = (owner: Partial<Worktree>) => linkedRow(FRONTEND_URL, owner)

  it('reads each row under its own host, including SSH behind a paired server', () => {
    const repos = [local, paired]
    expect(findWorktreeRepo(repos, at({ hostId: 'local' }))).toBe(local)
    expect(
      findWorktreeRepo(repos, at({ hostId: 'ssh:target', runtimeOwnerEnvironmentId: 'env-1' }))
    ).toBe(paired)
    // A pre-host row resolves only when its repo id has a single owner.
    expect(findWorktreeRepo([local], at({}))).toBe(local)
    expect(findWorktreeRepo(repos, at({}))).toBeUndefined()
  })

  it('a row on a second host is judged against that host’s repository', () => {
    // Same repo id on two hosts; the paired one is relayto-frontend itself.
    const frontend = {
      ...paired,
      gitRemoteIdentity: {
        canonicalKey: 'github.com/relayto/relayto-frontend',
        remoteName: 'origin',
        remoteUrl: 'git@github.com:relayto/relayto-frontend.git'
      }
    }
    const remoteRow = at({ hostId: 'runtime:env-1', runtimeOwnerEnvironmentId: 'env-1' })
    const store = createTestStore()
    store.setState({ repos: [local, frontend], worktreesByRepo: { [repo.id]: [remoteRow] } })

    expect(buildPRRefreshCandidate(store.getState(), remoteRow)).not.toHaveProperty(
      'linkedPRRepository'
    )
    expect(isStaleExactLinkedPRLookup(store.getState(), remoteRow.id, 2383, null, frontend)).toBe(
      false
    )
  })
})

describe('a pre-host row whose repo id spans hosts', () => {
  const DOCKER_URL = 'https://github.com/relayto/relayto-docker/pull/2383'
  const dockerPR = makePR({ number: 2383, url: DOCKER_URL })
  const local = { ...repo, executionHostId: 'local' as const }
  const remote = { ...repo, path: '/remote/docker', connectionId: 'box' }
  // An SSH clone not probed yet cannot tell its own PR URLs from another repository's.
  const unprobedRemote = { ...remote, gitRemoteIdentity: null }
  const store = createTestStore()
  const show = (repos: Repo[], url = DOCKER_URL) =>
    store.setState({
      repos,
      worktreesByRepo: { [repo.id]: [linkedRow(url)] },
      prCache: {},
      hostedReviewCache: {},
      settings: null
    })
  const refreshFor = (requestRepo: Repo) => {
    const candidate = buildPRRefreshCandidate(
      store.getState(),
      linkedRow(DOCKER_URL),
      undefined,
      requestRepo
    )
    if (!candidate) {
      throw new Error('expected a refresh candidate')
    }
    store.getState().applyGitHubPRRefreshEvent({
      sequence: 1,
      reason: 'swr',
      aliases: [candidate],
      outcome: { kind: 'found', pr: dockerPR, fetchedAt: 1 }
    })
    return store.getState().prCache[candidate.cacheKey]?.data
  }
  const fetchFor = (requestRepo: Repo) =>
    store.getState().fetchPRForBranch(requestRepo.path, 'main', {
      worktreeId: linkedRow(DOCKER_URL).id,
      linkedPRNumber: 2383,
      force: true
    })

  beforeEach(() => {
    mockApi.gh.refreshPRNow.mockReset().mockResolvedValue({
      kind: 'found',
      pr: dockerPR,
      fetchedAt: 1
    })
  })

  it.each([
    ['both hosts probed, the first one requesting', [local, remote], local],
    ['the requesting host listed after an unprobed one', [unprobedRemote, local], local]
  ])('keeps the row’s own PR fresh (%s)', async (_label, repos, requestRepo) => {
    show(repos)
    expect(refreshFor(requestRepo)).toEqual(dockerPR)

    show(repos)
    await expect(fetchFor(requestRepo)).resolves.toEqual(dockerPR)
  })

  it('still discards the row’s own PR once the link moved to another repository', () => {
    show([local, remote], FRONTEND_URL)
    expect(
      isStaleExactLinkedPRLookup(store.getState(), linkedRow(DOCKER_URL).id, 2383, null, local)
    ).toBe(true)
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

  it('treats a lookup for the same number in another repository as stale', () => {
    const id = linkedRow(FRONTEND_URL).id
    expect(isStaleExactLinkedPRLookup(store.getState(), id, 2383, FRONTEND, repo)).toBe(false)
    // A result for the row's own #2383, or another repository's, must not land on this link.
    expect(isStaleExactLinkedPRLookup(store.getState(), id, 2383, null, repo)).toBe(true)
    expect(isStaleExactLinkedPRLookup(store.getState(), id, 2383, API, repo)).toBe(true)
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

describe('repository identity in renderer review caches', () => {
  const store = createTestStore()
  const cacheKey = getHostedReviewCacheKey(repo.path, 'main', null, repo.id, null, null, true)
  const reviewFrom = (slug: string) =>
    hostedReviewInfoFromGitHubPRInfo(
      makePR({ number: 2383, url: `https://github.com/${slug}/pull/2383` })
    )
  const fetchRowReview = () =>
    store
      .getState()
      .fetchHostedReviewForBranch(repo.path, 'main', { repoId: repo.id, linkedGitHubPR: 2383 })

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

  it('a resolved PR answers the hint of the request that linked it', () => {
    const request = linkedReviewHintKey({
      linkedGitHubPR: 2383,
      linkedGitHubPRRepository: FRONTEND
    })
    expect(request).not.toBe(
      linkedReviewHintKey({ linkedGitHubPR: 2383, linkedGitHubPRRepository: API })
    )
    expect(githubPRHintKey({ number: 2383, linkedFromOtherRepository: true }, FRONTEND)).toBe(
      request
    )
    expect(githubPRHintKey({ number: 2383 }, FRONTEND)).toBe(
      linkedReviewHintKey({ linkedGitHubPR: 2383 })
    )
  })

  it('never serves a fresh review of the same number from another repository', async () => {
    const cached = (repository: typeof FRONTEND) => ({
      [cacheKey]: {
        data: reviewFrom(`${repository.owner}/${repository.repo}`),
        fetchedAt: Date.now(),
        linkedReviewHintKey: linkedReviewHintKey({
          linkedGitHubPR: 2383,
          linkedGitHubPRRepository: repository
        })
      }
    })
    store.setState({ hostedReviewCache: cached(API) })
    await fetchRowReview()
    expect(mockApi.hostedReview.forBranch).toHaveBeenCalledTimes(1)

    mockApi.hostedReview.forBranch.mockClear()
    store.setState({ hostedReviewCache: cached(FRONTEND) })
    await fetchRowReview()
    expect(mockApi.hostedReview.forBranch).not.toHaveBeenCalled()
  })

  it('discards an older host’s answer with this repository’s PR of the same number', async () => {
    mockApi.hostedReview.forBranch.mockResolvedValue(reviewFrom('relayto/relayto-docker'))

    await expect(fetchRowReview()).resolves.toBeNull()
    expect(store.getState().hostedReviewCache[cacheKey]?.data).toBeNull()
  })

  it.each([
    ['inferred', undefined],
    ['caller-supplied', FRONTEND]
  ])(
    'does not cache a review that finished after the row moved its link elsewhere (%s repository)',
    async (_label, linkedGitHubPRRepository) => {
      const pending = Promise.withResolvers<ReturnType<typeof reviewFrom> | null>()
      mockApi.hostedReview.forBranch.mockReturnValueOnce(pending.promise)

      const request = store.getState().fetchHostedReviewForBranch(repo.path, 'main', {
        repoId: repo.id,
        linkedGitHubPR: 2383,
        ...(linkedGitHubPRRepository ? { linkedGitHubPRRepository } : {})
      })
      store.setState({
        worktreesByRepo: {
          [repo.id]: [linkedRow('https://github.com/relayto/relayto-api/pull/2383')]
        }
      })
      pending.resolve(reviewFrom('relayto/relayto-frontend'))
      await request

      expect(store.getState().hostedReviewCache[cacheKey]).toBeUndefined()
    }
  )

  it('applies the same guards to direct PR lookups and cached PRs', () => {
    const docker = makePR({
      number: 2383,
      url: 'https://github.com/relayto/relayto-docker/pull/2383'
    })
    const frontend = makePR({ number: 2383, url: FRONTEND_URL, linkedFromOtherRepository: true })
    const found = (pr: typeof docker) => ({ kind: 'found' as const, pr, fetchedAt: 1 })
    expect(foundPRForLinkedRepository(found(docker), FRONTEND)).toBeNull()
    expect(foundPRForLinkedRepository(found(frontend), FRONTEND)).toBe(frontend)
    expect(foundPRForLinkedRepository(found(docker), null)).toBe(docker)
    expect(isCachedPRForLinkedRepository(docker, 2383, FRONTEND)).toBe(false)
    expect(isCachedPRForLinkedRepository(frontend, 2383, FRONTEND)).toBe(true)
    // Relinking the same number back into this repository refetches too.
    expect(isCachedPRForLinkedRepository(frontend, 2383, null)).toBe(false)
  })
})
