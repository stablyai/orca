import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { useAppStore } from '@/store/index'
import { seedStore } from '@/store/testing/app-store-test-fixture'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import { rememberRepoSlug, repoSlugCacheKey } from '@/lib/workspace/catalog/repo-slug-cache'
import { beginLinkOpenRequest } from '@/lib/links/link-open-request'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import {
  GITHUB_LINK_OPEN_TIMEOUT_MS,
  githubLinkOpenInOrcaAction,
  githubLinkTaskTarget
} from './github-link-task-target'
import type { Repo } from '../../../../../shared/repository/repo-types'
import type { Worktree } from '../../../../../shared/worktree/types'

vi.mock('@/store/index', async () => {
  const { createTestStore } = await import('@/store/testing/app-store-test-fixture')
  return { useAppStore: createTestStore() }
})
const runtimeRpc = vi.hoisted(() => ({ answer: Promise.resolve<unknown>(null) }))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({
  callRuntimeRpc: vi.fn(() => runtimeRpc.answer)
}))
vi.mock('sonner', () => ({
  toast: { loading: vi.fn(() => 'toast'), error: vi.fn(), dismiss: vi.fn() }
}))

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void }
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const workItemByOwnerRepo = vi.fn()
const openTaskPage = vi.fn()
const initialState = useAppStore.getState()
const PR_URL = 'https://github.com/acme/web/pull/21'
const ISSUE_URL = 'https://github.com/acme/web/issues/7'

function repo(overrides: Partial<Repo> & { id: string; path: string }): Repo {
  return { displayName: overrides.id, badgeColor: '#000', addedAt: 0, kind: 'git', ...overrides }
}
function worktree(repoId: string, path: string, hostId?: Worktree['hostId']): Worktree {
  return makeWorktree({ id: `${repoId}::${path}`, repoId, path, ...(hostId ? { hostId } : {}) })
}
function seed(repos: Repo[], worktrees: Worktree[]): void {
  const worktreesByRepo: Record<string, Worktree[]> = {}
  for (const entry of worktrees) {
    worktreesByRepo[entry.repoId] = [...(worktreesByRepo[entry.repoId] ?? []), entry]
  }
  seedStore(useAppStore, { repos, worktreesByRepo })
}
function workItem(type: 'pr' | 'issue', number: number, owner = 'acme', name = 'web') {
  return {
    id: `${type}:${number}`,
    type,
    number,
    title: 'Item',
    state: 'open',
    url: `https://github.com/${owner}/${name}/${type === 'pr' ? 'pull' : 'issues'}/${number}`,
    labels: [],
    updatedAt: '2026-11-20T00:00:00Z',
    author: null
  }
}
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await Promise.resolve()
  }
}
function action(worktreeId: string, url: string) {
  return githubLinkOpenInOrcaAction(worktreeId, url)
}

const solo = repo({ id: 'solo', path: '/local/repo' })
const soloWorktree = worktree('solo', '/local/repo')

beforeEach(() => {
  useAppStore.setState(initialState, true)
  useAppStore.setState({ openTaskPage })
  workItemByOwnerRepo.mockReset()
  openTaskPage.mockReset()
  vi.mocked(callRuntimeRpc).mockClear()
  vi.mocked(toast.error).mockClear()
  Object.assign(globalThis, { window: { api: { gh: { workItemByOwnerRepo } } } })
})
afterEach(() => {
  vi.useRealTimers()
})

describe('which links offer the row (source project, S5)', () => {
  it('T1a: no row when the clicked worktree runs on another host than the unique row', () => {
    seed([solo], [worktree('solo', '/srv/w', 'runtime:builder')])
    expect(action('solo::/srv/w', PR_URL)).toBeNull()
  })

  it('T1b: no row when the clicked worktree is unknown (stale surface)', () => {
    seed([solo], [])
    expect(action('solo::/nowhere', PR_URL)).toBeNull()
  })

  it('T1c: no row when an SSH row is on another target than the worktree', () => {
    seed(
      [repo({ id: 's', path: '/home/x/repo', connectionId: 'T' })],
      [worktree('s', '/home/x/repo', 'ssh:U')]
    )
    expect(action('s::/home/x/repo', PR_URL)).toBeNull()
  })

  it.each([
    ['local', solo, soloWorktree],
    [
      'runtime',
      repo({ id: 'r', path: '/srv/repo', executionHostId: 'runtime:builder' }),
      worktree('r', '/srv/repo', 'runtime:builder')
    ],
    [
      'ssh',
      repo({ id: 's', path: '/home/x/repo', connectionId: 'T' }),
      worktree('s', '/home/x/repo', 'ssh:T')
    ],
    [
      'fork clone',
      repo({ id: 'fork', path: '/fork', upstream: { owner: 'acme', repo: 'web' } }),
      worktree('fork', '/fork')
    ]
  ])('T1d: a %s workspace offers the row for its PR and issue links', (_, row, entry) => {
    seed([row], [entry])
    expect(action(entry.id, PR_URL)?.icon).toBe('open-in-orca')
    expect(action(entry.id, ISSUE_URL)?.icon).toBe('open-in-orca')
  })

  it('T1e: no row when the project is registered on two hosts under one id', () => {
    seed(
      [solo, repo({ id: 'solo', path: '/srv/repo', executionHostId: 'runtime:builder' })],
      [soloWorktree]
    )
    expect(action(soloWorktree.id, PR_URL)).toBeNull()
  })

  it('T2a: a stale cached origin neither hides the row nor routes the click', async () => {
    const second = repo({ id: 'solo', path: '/second/repo', connectionId: 'U' })
    rememberRepoSlug(repoSlugCacheKey(second)!, 'acme/first', Date.now())
    seed([second], [worktree('solo', '/second/repo', 'ssh:U')])
    workItemByOwnerRepo.mockResolvedValue(workItem('pr', 21, 'acme', 'second'))

    const row = action('solo::/second/repo', 'https://github.com/acme/second/pull/21')
    await row?.run()

    expect(workItemByOwnerRepo).toHaveBeenCalledWith(
      expect.objectContaining({ repoPath: '/second/repo', owner: 'acme', repo: 'second' })
    )
    expect(openTaskPage).toHaveBeenCalledTimes(1)
  })

  it('T2b: a link main does not count as the project ends in the neutral toast', async () => {
    const second = repo({ id: 'solo', path: '/second/repo', connectionId: 'U' })
    rememberRepoSlug(repoSlugCacheKey(second)!, 'acme/first', Date.now())
    seed([second], [worktree('solo', '/second/repo', 'ssh:U')])
    workItemByOwnerRepo.mockResolvedValue(null)

    const row = action('solo::/second/repo', 'https://github.com/acme/first/pull/21')
    expect(row).not.toBeNull()
    await row?.run()

    expect(openTaskPage).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalledTimes(1)
  })

  it('T2c: other forges get no row unless the row names their host', () => {
    seed([repo({ ...solo, ghAccount: { host: 'ghe.acme.io', user: 'me' } })], [soloWorktree])
    expect(action(soloWorktree.id, 'https://gitea.example/a/b/issues/3')).toBeNull()
    expect(action(soloWorktree.id, 'https://ghe.acme.io/infra/api/pull/4')?.icon).toBe(
      'open-in-orca'
    )
  })
})

describe('the click', () => {
  async function clickWithPendingLookup(url = PR_URL) {
    const lookup = deferred<unknown>()
    workItemByOwnerRepo.mockReturnValue(lookup.promise)
    const run = action(soloWorktree.id, url)!.run()
    await settle()
    return { lookup, run }
  }

  it('T7: an unchanged source opens the item stamped with its project and host', async () => {
    seed([solo], [soloWorktree])
    const { lookup, run } = await clickWithPendingLookup(`${PR_URL}/files`)
    lookup.resolve(workItem('pr', 21))
    await run

    expect(openTaskPage).toHaveBeenCalledWith(
      expect.objectContaining({
        taskSource: 'github',
        preselectedRepoId: 'solo',
        openGitHubInitialTab: 'files',
        openGitHubWorkItem: expect.objectContaining({
          number: 21,
          repoId: 'solo',
          repoHostId: 'local'
        })
      })
    )
  })

  it('T1f: a worktree that moves to another host mid-lookup drops the open', async () => {
    seed([solo], [soloWorktree])
    const { lookup, run } = await clickWithPendingLookup()
    seed([solo], [worktree('solo', '/local/repo', 'runtime:builder')])
    lookup.resolve(workItem('pr', 21))
    await run

    expect(openTaskPage).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['the source row is removed', () => seed([], [soloWorktree])],
    [
      'a twin is added',
      () =>
        seed(
          [solo, repo({ id: 'solo', path: '/srv/repo', executionHostId: 'runtime:builder' })],
          [soloWorktree]
        )
    ]
  ])('T1g: no navigation when %s mid-lookup', async (_, change) => {
    seed([solo], [soloWorktree])
    const { lookup, run } = await clickWithPendingLookup()
    change()
    lookup.resolve(workItem('pr', 21))
    await run

    expect(openTaskPage).not.toHaveBeenCalled()
  })

  it.each([
    ['the GitHub account', { ghAccount: { host: 'github.com', user: 'other' } }],
    ['the upstream', { upstream: { owner: 'other', repo: 'web' } }]
  ])('T7: a change to %s mid-lookup drops the open', async (_, change) => {
    seed([solo], [soloWorktree])
    const { lookup, run } = await clickWithPendingLookup()
    seed([{ ...solo, ...change }], [soloWorktree])
    lookup.resolve(workItem('pr', 21))
    await run

    expect(openTaskPage).not.toHaveBeenCalled()
  })

  it.each([
    [
      'a rename and recolor',
      () => seed([{ ...solo, displayName: 'New', badgeColor: '#fff' }], [soloWorktree])
    ],
    [
      'an edit to another project',
      () =>
        seed([solo, repo({ id: 'other', path: '/other', displayName: 'Other' })], [soloWorktree])
    ]
  ])('T7: %s mid-lookup still opens', async (_, change) => {
    seed([solo, repo({ id: 'other', path: '/other' })], [soloWorktree])
    const { lookup, run } = await clickWithPendingLookup()
    change()
    lookup.resolve(workItem('pr', 21))
    await run

    expect(openTaskPage).toHaveBeenCalledTimes(1)
  })

  it('T3a: a superseded open neither navigates nor publishes its issue reading', async () => {
    seed([solo], [soloWorktree])
    const acceptSearch = vi.spyOn(useAppStore.getState().githubTaskCache, 'acceptSearch')
    const { lookup, run } = await clickWithPendingLookup(ISSUE_URL)
    beginLinkOpenRequest()
    lookup.resolve(workItem('issue', 7))
    await run

    expect(openTaskPage).not.toHaveBeenCalled()
    expect(toast.error).not.toHaveBeenCalled()
    expect(acceptSearch).not.toHaveBeenCalled()
  })

  it('T3b: an account rebind mid-lookup neither navigates nor publishes', async () => {
    seed([solo], [soloWorktree])
    const acceptSearch = vi.spyOn(useAppStore.getState().githubTaskCache, 'acceptSearch')
    const { lookup, run } = await clickWithPendingLookup(ISSUE_URL)
    seed([{ ...solo, ghAccount: { host: 'github.com', user: 'other' } }], [soloWorktree])
    lookup.resolve(workItem('issue', 7))
    await run

    expect(openTaskPage).not.toHaveBeenCalled()
    expect(acceptSearch).not.toHaveBeenCalled()
  })

  it('T3b: a nested SSH target change under the same runtime drops the open', async () => {
    const nested = repo({
      id: 'n',
      path: '/home/x/repo',
      executionHostId: 'runtime:builder',
      connectionId: 'T'
    })
    const nestedWorktree = worktree('n', '/home/x/repo', 'runtime:builder')
    seed([nested], [nestedWorktree])
    const lookup = deferred<unknown>()
    runtimeRpc.answer = lookup.promise
    const row = action(nestedWorktree.id, PR_URL)
    expect(row).not.toBeNull()
    const run = row!.run()
    await settle()
    seed([{ ...nested, connectionId: 'U' }], [nestedWorktree])
    lookup.resolve(workItem('pr', 21))
    await run

    expect(callRuntimeRpc).toHaveBeenCalledTimes(1)
    expect(openTaskPage).not.toHaveBeenCalled()
  })

  it('T3c: an account switched away and back mid-lookup still opens (ABA policy)', async () => {
    seed([solo], [soloWorktree])
    const { lookup, run } = await clickWithPendingLookup()
    seed([{ ...solo, ghAccount: { host: 'github.com', user: 'other' } }], [soloWorktree])
    seed([solo], [soloWorktree])
    lookup.resolve(workItem('pr', 21))
    await run

    expect(openTaskPage).toHaveBeenCalledTimes(1)
  })

  it('T4: a lookup that never settles fails at the watchdog and a late answer is dropped', async () => {
    vi.useFakeTimers()
    seed([solo], [soloWorktree])
    const { lookup, run } = await clickWithPendingLookup()
    await vi.advanceTimersByTimeAsync(GITHUB_LINK_OPEN_TIMEOUT_MS)
    await run
    expect(toast.error).toHaveBeenCalledTimes(1)

    lookup.resolve(workItem('pr', 21))
    await settle()
    expect(openTaskPage).not.toHaveBeenCalled()
  })
})

describe('T6: link targets', () => {
  it.each([
    ['https://www.github.com/a/b/pull/1', 'github.com'],
    ['https://WWW.GitHub.com/a/b/issues/1', 'github.com'],
    ['https://www.ghe.acme.io/a/b/pull/1', 'www.ghe.acme.io'],
    ['https://ghe.acme.io:8443/a/b/pull/1', 'ghe.acme.io:8443']
  ])('folds only the exact www.github.com host: %s', (url, host) => {
    expect(githubLinkTaskTarget(url)?.link.slug.host).toBe(host)
  })

  it.each([
    ['https://github.com/a/b/pull/21', 'conversation'],
    ['https://github.com/a/b/pull/21/files#diff-x', 'files'],
    ['https://github.com/a/b/pull/21/changes', 'files'],
    ['https://github.com/a/b/pull/21/checks', 'checks'],
    ['https://github.com/a/b/pull/21/commits', 'conversation'],
    ['https://github.com/a/b/pull/21#issuecomment-1', 'conversation'],
    ['https://github.com/a/b/issues/21/files', 'conversation']
  ])('opens %s on the %s tab', (url, tab) => {
    expect(githubLinkTaskTarget(url)?.initialTab).toBe(tab)
  })

  it('ignores links that are not a PR or issue', () => {
    expect(githubLinkTaskTarget('https://github.com/a/b/tree/main')).toBeNull()
  })
})
