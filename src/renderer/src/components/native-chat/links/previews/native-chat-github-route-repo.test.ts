import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../../../shared/repo-types'
import { parseGitHubIssueOrPRLink } from '../../../../../../shared/github/repositories/links'
import { clearRepoSlugCacheValues } from '@/lib/workspace/catalog/repo-slug-cache'

const mocks = vi.hoisted(() => {
  const repos: Repo[] = []
  return { repos, slugs: new Map<string, string | null>(), lookup: vi.fn() }
})

vi.mock('@/store/index', () => ({
  useAppStore: { getState: () => ({ repos: mocks.repos }) }
}))
vi.mock('@/lib/workspace/catalog/repo-slug-index', async () => {
  const { rememberRepoSlug, repoSlugCacheKey } =
    await import('@/lib/workspace/catalog/repo-slug-cache')
  return {
    resolveRepoSlug: async (repo: Repo) => {
      const slug = mocks.slugs.get(repo.id) ?? null
      const key = repoSlugCacheKey(repo)
      if (key) {
        rememberRepoSlug(key, slug)
      }
      return slug
    }
  }
})
vi.mock('@/lib/work-items/github/github-work-item-source-lookup', () => ({
  lookupGitHubWorkItemByOwnerRepoForSource: mocks.lookup
}))

const { githubPreviewRouteCandidates, pickGitHubPreviewRouteRepo } =
  await import('./native-chat-github-route-repo')
const { loadRoutedGitHubLinkPreview, readCachedRoutedGitHubLinkPreview } =
  await import('./native-chat-github-link-preview')

function repo(id: string, extra: Partial<Repo> = {}): Repo {
  return { id, path: `/src/${id}`, displayName: id, badgeColor: '', addedAt: 0, ...extra }
}

const privatePr = parseGitHubIssueOrPRLink('https://github.com/stablyai/orca-private/pull/685')!

describe('GitHub preview routing for a chat without a repo of its own', () => {
  beforeEach(() => {
    mocks.repos = []
    mocks.slugs.clear()
    clearRepoSlugCacheValues()
    mocks.lookup.mockReset()
  })

  it('keeps git repos on the chat host only', () => {
    const local = repo('local')
    const remote = repo('ssh', { connectionId: 'box' })
    const runtime = repo('rt', { executionHostId: 'runtime:env' })
    const folder = repo('folder', { kind: 'folder' })
    const all = [local, remote, runtime, folder]
    expect(githubPreviewRouteCandidates(all, 'local')).toEqual([local])
    expect(githubPreviewRouteCandidates(all, 'runtime:env')).toEqual([runtime])
  })

  it('prefers an exact clone before a fork upstream, then any repo on the GitHub host', () => {
    const orca = repo('orca')
    const fork = repo('fork', { upstream: { owner: 'stablyai', repo: 'orca-private' } })
    const clone = repo('clone')
    const ghes = repo('ghes')
    const rows = [
      { repo: ghes, originKey: 'git.corp.example/team/app' },
      { repo: orca, originKey: 'stablyai/orca' },
      { repo: fork, originKey: 'me/orca-private' },
      { repo: clone, originKey: 'stablyai/orca-private' }
    ]
    expect(pickGitHubPreviewRouteRepo(rows, privatePr)).toBe(clone)
    expect(pickGitHubPreviewRouteRepo(rows.slice(0, 3), privatePr)).toBe(fork)
    expect(pickGitHubPreviewRouteRepo(rows.slice(0, 2), privatePr)).toBe(orca)
    expect(pickGitHubPreviewRouteRepo(rows.slice(0, 1), privatePr)).toBeNull()
    expect(pickGitHubPreviewRouteRepo([{ repo: orca, originKey: null }], privatePr)).toBeNull()
  })

  it('looks a private PR up through a local repo on github.com, as a preview', async () => {
    const orca = repo('orca')
    mocks.repos = [repo('folder', { kind: 'folder' }), orca]
    mocks.slugs.set('orca', 'stablyai/orca')
    const item = { type: 'pr', number: 685, title: 'perf: cacheable projections', state: 'draft' }
    mocks.lookup.mockResolvedValue(item)

    await expect(loadRoutedGitHubLinkPreview('local', privatePr)).resolves.toBe(item)
    expect(mocks.lookup.mock.calls[0][0]).toMatchObject({
      repoPath: '/src/orca',
      repoId: 'orca',
      owner: 'stablyai',
      repo: 'orca-private',
      number: 685,
      type: 'pr',
      preview: true
    })
  })

  it('answers nothing, leaving the web card, when no repo on the chat host uses GitHub', async () => {
    mocks.repos = [repo('ghes')]
    mocks.slugs.set('ghes', 'git.corp.example/team/app')
    const link = parseGitHubIssueOrPRLink('https://github.com/stablyai/orca-private/pull/686')!
    await expect(loadRoutedGitHubLinkPreview('local', link)).resolves.toBeNull()
    expect(mocks.lookup).not.toHaveBeenCalled()
  })

  it('uses the remaining repo after the repo that answered is removed', async () => {
    const link = parseGitHubIssueOrPRLink('https://github.com/acme/private/pull/701')!
    const alice = repo('alice', { ghAccount: { host: 'github.com', user: 'alice' } })
    const bob = repo('bob', { ghAccount: { host: 'github.com', user: 'bob' } })
    mocks.repos = [alice, bob]
    mocks.slugs.set('alice', 'acme/alice')
    mocks.slugs.set('bob', 'acme/bob')
    mocks.lookup.mockImplementation(async ({ repoId }) => ({ title: `${repoId}'s preview` }))

    await expect(loadRoutedGitHubLinkPreview('local', link)).resolves.toEqual({
      title: "alice's preview"
    })
    mocks.repos = [bob]
    expect(readCachedRoutedGitHubLinkPreview('local', link)).toBeNull()
    await expect(loadRoutedGitHubLinkPreview('local', link)).resolves.toEqual({
      title: "bob's preview"
    })
  })

  it('leaves no cached preview when the last eligible repo is removed', async () => {
    const link = parseGitHubIssueOrPRLink('https://github.com/acme/private/pull/702')!
    mocks.repos = [repo('alice')]
    mocks.slugs.set('alice', 'acme/alice')
    mocks.lookup.mockResolvedValue({ title: "alice's preview" })

    await expect(loadRoutedGitHubLinkPreview('local', link)).resolves.toEqual({
      title: "alice's preview"
    })
    mocks.repos = []
    expect(readCachedRoutedGitHubLinkPreview('local', link)).toBeNull()
    await expect(loadRoutedGitHubLinkPreview('local', link)).resolves.toBeNull()
  })

  it('reloads a preview when the answering repo changes its account binding', async () => {
    const link = parseGitHubIssueOrPRLink('https://github.com/acme/private/pull/703')!
    const alice = repo('bound', { ghAccount: { host: 'github.com', user: 'alice' } })
    mocks.repos = [alice]
    mocks.slugs.set('bound', 'acme/bound')
    mocks.lookup.mockResolvedValueOnce({ title: "alice's preview" }).mockResolvedValueOnce(null)

    await expect(loadRoutedGitHubLinkPreview('local', link)).resolves.toEqual({
      title: "alice's preview"
    })
    mocks.repos = [{ ...alice, ghAccount: { host: 'github.com', user: 'bob' } }]
    expect(readCachedRoutedGitHubLinkPreview('local', link)).toBeNull()
    await expect(loadRoutedGitHubLinkPreview('local', link)).resolves.toBeNull()
  })

  it('uses a newly resolved exact clone instead of the previously cached fallback', async () => {
    const link = parseGitHubIssueOrPRLink('https://github.com/acme/private/pull/704')!
    mocks.repos = [repo('alice'), repo('bob')]
    mocks.slugs.set('bob', 'acme/bob')
    mocks.lookup.mockImplementation(async ({ repoId }) => ({ title: `${repoId}'s preview` }))

    await expect(loadRoutedGitHubLinkPreview('local', link)).resolves.toEqual({
      title: "bob's preview"
    })
    mocks.slugs.set('alice', 'acme/private')
    await expect(loadRoutedGitHubLinkPreview('local', link)).resolves.toEqual({
      title: "alice's preview"
    })
    expect(readCachedRoutedGitHubLinkPreview('local', link)).toEqual({
      title: "alice's preview"
    })
  })
})
