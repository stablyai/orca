import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../../../shared/repo-types'
import { parseGitHubIssueOrPRLink } from '../../../../../../shared/github/repositories/links'

const mocks = vi.hoisted(() => {
  const repos: Repo[] = []
  return { repos, slugs: new Map<string, string | null>(), lookup: vi.fn() }
})

vi.mock('@/store/index', () => ({
  useAppStore: { getState: () => ({ repos: mocks.repos }) }
}))
vi.mock('@/lib/workspace/catalog/repo-slug-index', () => ({
  resolveRepoSlug: async (repo: Repo) => mocks.slugs.get(repo.id) ?? null
}))
vi.mock('@/lib/work-items/github/github-work-item-source-lookup', () => ({
  lookupGitHubWorkItemByOwnerRepoForSource: mocks.lookup
}))

const { githubPreviewRouteCandidates, pickGitHubPreviewRouteRepo } =
  await import('./native-chat-github-route-repo')
const { loadRoutedGitHubLinkPreview } = await import('./native-chat-github-link-preview')

function repo(id: string, extra: Partial<Repo> = {}): Repo {
  return { id, path: `/src/${id}`, displayName: id, badgeColor: '', addedAt: 0, ...extra }
}

const privatePr = parseGitHubIssueOrPRLink('https://github.com/stablyai/orca-private/pull/685')!

describe('GitHub preview routing for a chat without a repo of its own', () => {
  beforeEach(() => {
    mocks.repos = []
    mocks.slugs.clear()
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

  it("prefers the linked repo's own clone, then any repo on the same GitHub host", () => {
    const orca = repo('orca')
    const fork = repo('fork', { upstream: { owner: 'stablyai', repo: 'orca-private' } })
    const ghes = repo('ghes')
    const rows = [
      { repo: ghes, originKey: 'git.corp.example/team/app' },
      { repo: orca, originKey: 'stablyai/orca' },
      { repo: fork, originKey: 'me/orca-private' }
    ]
    expect(pickGitHubPreviewRouteRepo(rows, privatePr)).toBe(fork)
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
})
