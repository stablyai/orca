// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../../../shared/repo-types'
import { parseGitHubIssueOrPRLink } from '../../../../../../shared/github/repositories/links'
import { githubRepoIdentityKey } from '../../../../../../shared/github/repositories/repository-identity-key'
import {
  clearRepoSlugCacheValues,
  rememberRepoSlug,
  repoSlugCacheKey
} from '@/lib/workspace/catalog/repo-slug-cache'
import type * as RouteRepo from './native-chat-github-route-repo'

const mocks = await vi.hoisted(async () => {
  const { create } = await import('zustand')
  return {
    store: create<{ repos: Repo[]; tick: number }>(() => ({ repos: [], tick: 0 })),
    endpoint: vi.fn(),
    scans: 0
  }
})
vi.mock('@/store/index', () => ({ useAppStore: mocks.store }))
vi.mock('@/lib/workspace/catalog/repo-slug-index', async () => {
  const { readRepoSlugCache, repoSlugCacheKey } =
    await import('@/lib/workspace/catalog/repo-slug-cache')
  return {
    resolveRepoSlug: async (repo: Repo) => {
      const key = repoSlugCacheKey(repo)
      const cached = key ? readRepoSlugCache(key) : null
      return cached?.hit ? cached.value : null
    }
  }
})
vi.mock('./native-chat-github-route-repo', async (importOriginal) => {
  const actual = await importOriginal<typeof RouteRepo>()
  return {
    ...actual,
    githubPreviewRouteCandidates: (
      ...args: Parameters<typeof actual.githubPreviewRouteCandidates>
    ) => {
      mocks.scans += 1
      return actual.githubPreviewRouteCandidates(...args)
    },
    readGitHubPreviewRouteRepo: (...args: Parameters<typeof actual.readGitHubPreviewRouteRepo>) => {
      mocks.scans += 1
      return actual.readGitHubPreviewRouteRepo(...args)
    }
  }
})

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

const repos = Array.from({ length: 200 }, (_, index) => repo(index))
let container: HTMLDivElement
let root: Root

beforeEach(() => {
  clearRepoSlugCacheValues()
  for (const row of repos) {
    rememberRepoSlug(
      repoSlugCacheKey(row)!,
      githubRepoIdentityKey({ owner: 'acme', repo: row.id, host: 'github.com' })
    )
  }
  mocks.store.setState({ repos, tick: 0 })
  mocks.endpoint.mockReset()
  mocks.endpoint.mockReturnValue(new Promise(() => {}))
  vi.stubGlobal('api', { gh: { workItemByOwnerRepo: mocks.endpoint } })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

it('leaves a pending routed preview alone on store updates that do not touch repos', async () => {
  const link = parseGitHubIssueOrPRLink('https://github.com/acme/repo-7/pull/42')!
  await act(async () => {
    root.render(
      <NativeChatGitHubPeekBody source={{ kind: 'routed', authorityKey: 'local' }} link={link} />
    )
  })
  expect(mocks.endpoint).toHaveBeenLastCalledWith(expect.objectContaining({ repoId: 'repo-7' }))

  mocks.scans = 0
  act(() => {
    for (let tick = 1; tick <= 1000; tick += 1) {
      mocks.store.setState({ tick })
    }
  })
  expect(mocks.scans).toBe(0)

  // Removing the linked repo's clone still reroutes the card through another repo on its host.
  await act(async () => {
    mocks.store.setState({ repos: repos.filter((row) => row.id !== 'repo-7') })
  })
  expect(mocks.endpoint).toHaveBeenLastCalledWith(expect.objectContaining({ repoId: 'repo-0' }))
})
