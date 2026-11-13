// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../../../shared/repo-types'
import type { GitHubWorkItem } from '../../../../../../shared/github/work-items/work-item-types'
import { parseGitHubIssueOrPRLink } from '../../../../../../shared/github/repositories/links'
import { clearRepoSlugCacheValues } from '@/lib/workspace/catalog/repo-slug-cache'
import { useRepoSlugIndex } from '@/lib/workspace/catalog/repo-slug-index'

const mocks = await vi.hoisted(async () => {
  const { create } = await import('zustand')
  return {
    store: create<{ repos: Repo[]; tick: number }>(() => ({ repos: [], tick: 0 })),
    endpoint: vi.fn(),
    slug: vi.fn()
  }
})
vi.mock('@/store/index', () => ({ useAppStore: mocks.store }))

const { NativeChatGitHubPeekBody } = await import('./NativeChatGitHubLinkPeek')

globalThis.IS_REACT_ACT_ENVIRONMENT = true

function repo(index: number): Repo {
  return {
    id: `repo-${index}`,
    path: `/repos/${index}`,
    displayName: `Repo ${index}`,
    badgeColor: '',
    addedAt: 0
  }
}

function preview(number: number, title: string): GitHubWorkItem {
  return {
    id: `pr-${number}`,
    type: 'pr',
    number,
    title,
    state: 'open',
    url: `https://github.com/acme/repo-2/pull/${number}`,
    labels: [],
    updatedAt: '',
    author: null,
    repoId: 'repo-2'
  }
}

function ProjectSlugIndex(): null {
  useRepoSlugIndex()
  return null
}

const repos = Array.from({ length: 3 }, (_, index) => repo(index))
let container: HTMLDivElement
let root: Root

beforeEach(() => {
  clearRepoSlugCacheValues()
  mocks.store.setState({ repos, tick: 0 })
  mocks.endpoint.mockReset()
  mocks.endpoint.mockReturnValue(new Promise(() => {}))
  mocks.slug.mockReset()
  mocks.slug.mockImplementation(async ({ repoId }: { repoId: string }) => ({
    owner: 'acme',
    repo: repoId
  }))
  vi.stubGlobal('api', { gh: { workItemByOwnerRepo: mocks.endpoint, repoSlug: mocks.slug } })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

it('shows the pending response after an unrelated store update', async () => {
  const response = Promise.withResolvers<GitHubWorkItem>()
  const started = Promise.withResolvers<void>()
  mocks.endpoint.mockImplementationOnce(() => {
    started.resolve()
    return response.promise
  })
  const link = parseGitHubIssueOrPRLink('https://github.com/acme/repo-2/pull/42')!
  await act(async () => {
    root.render(
      <NativeChatGitHubPeekBody source={{ kind: 'routed', authorityKey: 'local' }} link={link} />
    )
  })
  await started.promise
  await act(async () => {
    mocks.store.setState({ tick: 1 })
  })
  await act(async () => {
    response.resolve(preview(42, 'Pending preview completed'))
  })
  expect(container.textContent).toContain('Pending preview completed')
})

it('shows the new route response and ignores a late response from the removed route', async () => {
  const oldResponse = Promise.withResolvers<GitHubWorkItem>()
  const newResponse = Promise.withResolvers<GitHubWorkItem>()
  const oldStarted = Promise.withResolvers<void>()
  const newStarted = Promise.withResolvers<void>()
  mocks.endpoint.mockImplementation(({ repoId }: { repoId: string }) => {
    if (repoId === 'repo-2') {
      oldStarted.resolve()
      return oldResponse.promise
    }
    newStarted.resolve()
    return newResponse.promise
  })
  const link = parseGitHubIssueOrPRLink('https://github.com/acme/repo-2/pull/43')!
  await act(async () => {
    root.render(
      <NativeChatGitHubPeekBody source={{ kind: 'routed', authorityKey: 'local' }} link={link} />
    )
  })
  await oldStarted.promise
  await act(async () => {
    mocks.store.setState({ repos: repos.filter((row) => row.id !== 'repo-2') })
  })
  await newStarted.promise
  await act(async () => {
    newResponse.resolve(preview(43, 'Current route preview'))
  })
  expect(container.textContent).toContain('Current route preview')
  await act(async () => {
    oldResponse.resolve(preview(43, 'Outdated route preview'))
  })
  expect(container.textContent).toContain('Current route preview')
  expect(container.textContent).not.toContain('Outdated route preview')
})

it('recovers an open fallback when the project slug index retries a failed slug', async () => {
  vi.useFakeTimers()
  mocks.store.setState({ repos: [repos[2]] })
  mocks.slug.mockResolvedValueOnce(null)
  mocks.endpoint.mockResolvedValue(preview(44, 'Recovered preview'))
  const link = parseGitHubIssueOrPRLink('https://github.com/acme/repo-2/pull/44')!
  await act(async () => {
    root.render(
      <>
        <NativeChatGitHubPeekBody
          source={{ kind: 'routed', authorityKey: 'local' }}
          link={link}
          otherRepoFallback={<span>Link fallback</span>}
        />
        <ProjectSlugIndex />
      </>
    )
  })
  expect(container.textContent).toBe('Link fallback')
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60_000)
  })
  await act(async () => {
    mocks.store.setState({ tick: 1 })
  })
  expect(container.textContent).toContain('Recovered preview')
  expect(container.textContent).not.toContain('Link fallback')
})
