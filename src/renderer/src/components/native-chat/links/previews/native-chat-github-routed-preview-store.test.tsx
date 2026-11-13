// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../../../shared/repo-types'
import { parseGitHubIssueOrPRLink } from '../../../../../../shared/github/repositories/links'
import { clearRepoSlugCacheValues } from '@/lib/workspace/catalog/repo-slug-cache'

const mocks = await vi.hoisted(async () => {
  const { create } = await import('zustand')
  return {
    store: create<{ repos: Repo[]; tick: number }>(() => ({ repos: [], tick: 0 })),
    endpoint: vi.fn()
  }
})
vi.mock('@/store/index', () => ({ useAppStore: mocks.store }))
vi.mock('@/lib/workspace/catalog/repo-slug-index', async () => {
  const { rememberRepoSlug, repoSlugCacheKey } =
    await import('@/lib/workspace/catalog/repo-slug-cache')
  return {
    resolveRepoSlug: async (repo: Repo) => {
      await Promise.resolve()
      const slug = `acme/${repo.id}`
      rememberRepoSlug(repoSlugCacheKey(repo)!, slug)
      return slug
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

const repos = Array.from({ length: 3 }, (_, index) => repo(index))
let container: HTMLDivElement
let root: Root

beforeEach(() => {
  clearRepoSlugCacheValues()
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

it('keeps a pending routed preview mounted until the repos change', async () => {
  const link = parseGitHubIssueOrPRLink('https://github.com/acme/repo-2/pull/42')!
  await act(async () => {
    root.render(
      <NativeChatGitHubPeekBody source={{ kind: 'routed', authorityKey: 'local' }} link={link} />
    )
  })
  expect(mocks.endpoint).toHaveBeenLastCalledWith(expect.objectContaining({ repoId: 'repo-2' }))
  const card = container.firstElementChild

  // A store update that leaves repos alone must not remount the card and restart its lookup.
  await act(async () => {
    mocks.store.setState({ tick: 1 })
  })
  expect(container.firstElementChild).toBe(card)

  // Removing the linked repo's clone reroutes the card through another repo on its host.
  await act(async () => {
    mocks.store.setState({ repos: repos.filter((row) => row.id !== 'repo-2') })
  })
  expect(mocks.endpoint).toHaveBeenLastCalledWith(expect.objectContaining({ repoId: 'repo-0' }))
})
