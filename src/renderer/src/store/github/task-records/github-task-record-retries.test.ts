import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../../shared/repo-types'
import type { GitHubWorkItem } from '../../../../../shared/github/work-items/work-item-types'

import { createTestStore, mockApi, resetRemoteRuntimeMocks } from '../github-slice-test-harness'
import { getTaskPageRepoSourceContext } from '@/lib/work-items/task-repo-source-context'

const lookup = vi.hoisted(() => vi.fn())
vi.mock('@/lib/work-items/github/github-work-item-source-lookup', () => ({
  lookupGitHubWorkItemByOwnerRepoForSource: lookup
}))
const repo: Repo = {
  id: 'repo',
  path: '/repo',
  displayName: 'Repo',
  badgeColor: 'blue',
  addedAt: 1,
  ghAccount: { host: 'github.com', user: 'alice' }
}
const issue = (number: number): GitHubWorkItem => ({
  id: `issue:${number}`,
  repoId: 'repo',
  type: 'issue',
  number,
  title: 'Original',
  state: 'open',
  labels: [],
  assignees: [],
  url: `https://github.com/acme/widgets/issues/${number}`,
  author: null,
  updatedAt: '2026-10-31T12:00:02Z'
})

const user = { login: 'alice', name: 'Alice', avatarUrl: 'alice.png' }
const sources = {
  issues: { owner: 'acme', repo: 'widgets' },
  prs: null,
  originCandidate: null,
  upstreamCandidate: null
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((r, fail) => {
    resolve = r
    reject = fail
  })
  return { promise, resolve, reject }
}
async function flush() {
  for (let i = 0; i < 6; i++) {
    await Promise.resolve()
  }
}
/** A paired server on its own connection; `reconnect` advances it the way a dropped transport does. */

describe('task record reads across failures and reconnects', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRemoteRuntimeMocks()
    lookup.mockReset()
  })

  it('parks unusable reads, retries one per delivery oldest first, then shows the outside reversal', async () => {
    const store = createTestStore()
    store.setState({ repos: [repo] })
    const items = [42, 43, 44].map(issue)
    const sourceContext = getTaskPageRepoSourceContext(repo, 'github')
    const deliver = async () => {
      await store
        .getState()
        .fetchWorkItems(repo.id, repo.path, 20, '', { sourceContext, force: true })
      await flush()
    }
    mockApi.gh.listWorkItems.mockResolvedValue({ items, sources })
    await deliver()
    const cache = store.getState().githubTaskCache
    const binding = cache.capture(repo, sourceContext)!
    const answers = new Map<number, Promise<GitHubWorkItem | null>>()
    lookup.mockImplementation(async ({ number }) => answers.get(number) ?? null)
    for (const item of items) {
      cache.operation(item, binding, { assignees: { alice: user } })(true)
      await flush()
    }
    // Each newly settled write gets its own first read; all three answer nothing usable.

    // A teammate unassigns alice on GitHub; the search index already shows it at a newer version.
    const reversed = (item: GitHubWorkItem) => ({ ...item, updatedAt: '2026-10-31T13:00:00Z' })
    mockApi.gh.listWorkItems.mockResolvedValue({ items: items.map(reversed), sources })
    const shown = () =>
      Object.values(store.getState().workItemsCache)
        .flatMap((entry) => entry.data ?? [])
        .map((item) => cache.projectItem(item).assignees?.map((value) => value.login))
    const turns = async () => {
      await deliver()
    }
    // One retry per delivery for the binding, longest-waiting first; confirmed edits stay shown.
    await turns()
    await turns()
    await turns()
    expect(shown()).toEqual([['alice'], ['alice'], ['alice']])

    // 42's next turn is crossed by a new edit: its answer is refused and the settled edit reads again.
    const crossed = deferred<GitHubWorkItem | null>()
    answers.set(42, crossed.promise)
    await turns()
    const settle = cache.operation(items[0], binding, { labels: { bug: true } })
    crossed.resolve(reversed(items[0]))
    await flush()
    expect(shown()[0]).toEqual(['alice'])
    answers.set(42, Promise.resolve({ ...reversed(items[0]), labels: ['bug'] }))
    settle(true)
    await flush()

    expect(cache.projectItem(items[0])).toMatchObject({ assignees: [], labels: ['bug'] })
    const indexed = { ...reversed(items[0]), labels: ['bug'] }
    mockApi.gh.listWorkItems.mockResolvedValue({
      items: [indexed, ...items.slice(1).map(reversed)],
      sources
    })

    // The others recover on their next turns, and a cleared obligation is never read again.
    answers.set(43, Promise.resolve(reversed(items[1])))
    answers.set(44, Promise.resolve(reversed(items[2])))
    await turns()
    await turns()
    await turns()
    expect(shown()).toEqual([[], [], []])
  })
})
