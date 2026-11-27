// @vitest-environment happy-dom

import { act, useLayoutEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  GitHubWorkItem,
  GitHubWorkItemDetails
} from '../../../../../shared/github/work-items/work-item-types'
import { touchWorkItemDetailsCache, workItemDetailsCache } from './work-item-details-cache'
import { useGitHubWorkItemDetails } from './use-github-work-item-details'
import type * as FetchSettle from './work-item-details-fetch-settle'

const loadDetails = vi.hoisted(() => vi.fn<() => Promise<GitHubWorkItemDetails | null>>())

vi.mock('./work-item-details-fetch-settle', async (importOriginal) => ({
  ...(await importOriginal<typeof FetchSettle>()),
  loadOrdinaryWorkItemDetails: loadDetails
}))

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

// Why: side reads go through window.api; they stay pending and on* subscriptions return an unsubscribe.
function pendingBridge(): unknown {
  return new Proxy(() => {}, {
    get: (_target, key) =>
      typeof key === 'string' && /^on[A-Z]/.test(key) ? () => () => {} : pendingBridge(),
    apply: () => new Promise<never>(() => {})
  })
}

// Synthetic data only.
const item: GitHubWorkItem = {
  id: 'fixture-pr-12',
  type: 'pr',
  number: 12,
  title: 'Sample change',
  state: 'open',
  url: 'https://github.com/sample-org/sample-repo/pull/12',
  labels: [],
  updatedAt: '2026-01-05T09:00:00Z',
  author: 'sample-author',
  repoId: 'fixture-repo'
}

function details(body: string): GitHubWorkItemDetails {
  const { repoId: _repoId, ...rest } = item
  return { item: rest, body, comments: [] }
}

type Commit = {
  detailsPending: boolean
  detailsLoaded: boolean
  error: string | null
  body: string | undefined
  detailsCacheKey: string | null
}

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>
let commits: Commit[]

function Harness(): null {
  const state = useGitHubWorkItemDetails({
    workItem: item,
    repoPath: '/fixture/sample-repo',
    effectiveRepoId: 'fixture-repo',
    sourceContext: null
  })
  // Why: layout effects run on every commit before paint and before the passive effect that starts the read.
  useLayoutEffect(() => {
    commits.push({
      detailsPending: state.detailsPending,
      detailsLoaded: state.detailsLoaded,
      error: state.error,
      body: state.details?.body,
      detailsCacheKey: state.detailsCacheKey
    })
  })
  return null
}

async function mount(): Promise<void> {
  await act(async () => root.render(<Harness />))
}

beforeEach(() => {
  commits = []
  workItemDetailsCache.clear()
  loadDetails.mockReset()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  vi.stubGlobal('api', pendingBridge())
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

describe('useGitHubWorkItemDetails detailsPending', () => {
  it('is pending from the first commit of an uncached item while the read is held', async () => {
    loadDetails.mockReturnValue(new Promise(() => {}))
    await mount()
    expect(commits[0]).toMatchObject({ detailsPending: true, detailsLoaded: false })
    expect(commits.every((commit) => commit.detailsPending && !commit.detailsLoaded)).toBe(true)
    expect(loadDetails).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['empty', ''],
    ['nonempty', 'Sample description']
  ])('settles to loaded on a confirmed %s read', async (_label, body) => {
    let resolve: (value: GitHubWorkItemDetails) => void = () => {}
    loadDetails.mockReturnValue(new Promise((r) => (resolve = r)))
    await mount()
    expect(commits[0]).toMatchObject({ detailsPending: true, detailsLoaded: false })
    await act(async () => resolve(details(body)))
    expect(commits.at(-1)).toMatchObject({ detailsPending: false, detailsLoaded: true, body })
  })

  it('is not pending when cached details refresh in the background', async () => {
    loadDetails.mockReturnValue(new Promise(() => {}))
    await mount()
    const key = commits[0]?.detailsCacheKey
    expect(key).toBeTruthy()
    act(() => root.unmount())
    root = createRoot(container)
    commits = []
    touchWorkItemDetailsCache(key!, {
      details: details('Cached description'),
      fetchedAt: 0,
      pending: undefined,
      rereadOwed: true
    })
    await mount()
    expect(commits[0]).toMatchObject({ detailsPending: false, detailsLoaded: true })
    expect(commits.every((commit) => !commit.detailsPending)).toBe(true)
  })

  it('stops being pending when a cold read fails', async () => {
    let reject: (error: Error) => void = () => {}
    loadDetails.mockReturnValue(new Promise((_resolve, r) => (reject = r)))
    await mount()
    expect(commits[0]?.detailsPending).toBe(true)
    await act(async () => reject(new Error('Sample failure')))
    expect(commits.at(-1)).toMatchObject({
      detailsPending: false,
      detailsLoaded: false,
      error: 'Sample failure'
    })
  })
})
