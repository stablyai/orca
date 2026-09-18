import { beforeEach, describe, expect, it, vi } from 'vitest'
import { lookupSmartGitHubSubmitItem } from '@/lib/smart-github-submit'
import type { GitHubWorkItem } from '../../../../shared/github/work-item-types'
import { resolveSmartWorkspaceGithubDirectLink } from './smart-workspace-github-direct-link'
import type { RepoOption } from './smart-workspace-name-field-model'

vi.mock('@/lib/smart-github-submit', () => ({
  lookupSmartGitHubSubmitItem: vi.fn()
}))

vi.mock('@/lib/github-work-item-source-lookup', () => ({
  lookupGitHubWorkItemByOwnerRepoForSource: vi.fn(),
  lookupGitHubWorkItemForSource: vi.fn()
}))

const repoSlug = vi.fn()
const repoUpstream = vi.fn()

// @ts-expect-error focused preload mock
globalThis.window = { api: { gh: { repoSlug, repoUpstream } } }

const workItem = {
  id: 'item-1',
  type: 'issue',
  number: 14841,
  title: 'Issue',
  state: 'open',
  url: 'https://github.com/quarto-dev/quarto-cli/issues/14841',
  labels: [],
  updatedAt: '2026-01-01T00:00:00.000Z',
  author: 'cderv',
  repoId: 'repo-1'
} satisfies GitHubWorkItem

function makeRepo(overrides: Partial<RepoOption> = {}): RepoOption {
  return {
    id: 'repo-1',
    path: '/workspace/quarto-cli',
    displayName: 'quarto-cli',
    badgeColor: '#000',
    addedAt: 1,
    executionHostId: 'local',
    ...overrides
  } as RepoOption
}

async function resolvePaste(args: {
  owner: string
  repo: string
  host?: string
  selectedRepo: RepoOption
  repos?: readonly RepoOption[]
}) {
  const slug = {
    owner: args.owner,
    repo: args.repo,
    ...(args.host ? { host: args.host } : {})
  }
  return resolveSmartWorkspaceGithubDirectLink({
    directLink: { slug, number: 14841, type: 'issue' },
    crossRepoSwitchTarget: 'project',
    repoBackedSearchTargets: [],
    selectedRepo: args.selectedRepo,
    githubSourceContext: null,
    repos: args.repos ?? [],
    repoSlugCache: new Map(),
    handledCrossRepoUrlRef: { current: null },
    query: `https://github.com/${args.owner}/${args.repo}/issues/14841`
  })
}

describe('resolveSmartWorkspaceGithubDirectLink fork upstream matching', () => {
  beforeEach(() => {
    repoSlug.mockReset()
    repoUpstream.mockReset()
    vi.mocked(lookupSmartGitHubSubmitItem).mockReset()
    vi.mocked(lookupSmartGitHubSubmitItem).mockResolvedValue(workItem)
  })

  it("does not prompt to switch when the URL is the selected fork's upstream", async () => {
    const selectedRepo = makeRepo({
      upstream: { owner: 'quarto-dev', repo: 'quarto-cli' }
    })
    repoSlug.mockResolvedValue({ owner: 'cderv', repo: 'quarto-cli' })

    await expect(
      resolvePaste({ owner: 'quarto-dev', repo: 'quarto-cli', selectedRepo })
    ).resolves.toEqual({ items: [workItem], prompt: null })
    expect(lookupSmartGitHubSubmitItem).toHaveBeenCalledOnce()
    expect(repoUpstream).not.toHaveBeenCalled()
  })

  it('still prompts when the URL is a genuinely different repo', async () => {
    const selectedRepo = makeRepo({
      upstream: { owner: 'quarto-dev', repo: 'quarto-cli' }
    })
    repoSlug.mockResolvedValue({ owner: 'cderv', repo: 'quarto-cli' })

    await expect(resolvePaste({ owner: 'stablyai', repo: 'orca', selectedRepo })).resolves.toEqual({
      items: [],
      prompt: {
        link: {
          slug: { owner: 'stablyai', repo: 'orca' },
          number: 14841,
          type: 'issue'
        },
        matchingRepo: null
      }
    })
    expect(lookupSmartGitHubSubmitItem).not.toHaveBeenCalled()
  })

  it('still matches an origin-only project against its origin slug', async () => {
    const selectedRepo = makeRepo({ upstream: null })
    repoSlug.mockResolvedValue({ owner: 'stablyai', repo: 'orca' })

    await expect(resolvePaste({ owner: 'stablyai', repo: 'orca', selectedRepo })).resolves.toEqual({
      items: [workItem],
      prompt: null
    })
    expect(lookupSmartGitHubSubmitItem).toHaveBeenCalledOnce()
    expect(repoUpstream).not.toHaveBeenCalled()
  })

  it('treats a live upstream slug as the same project when fork metadata is unresolved', async () => {
    const selectedRepo = makeRepo()
    repoSlug.mockResolvedValue({ owner: 'cderv', repo: 'quarto-cli' })
    repoUpstream.mockResolvedValue({ owner: 'quarto-dev', repo: 'quarto-cli' })

    await expect(
      resolvePaste({ owner: 'quarto-dev', repo: 'quarto-cli', selectedRepo })
    ).resolves.toEqual({ items: [workItem], prompt: null })
    expect(repoUpstream).toHaveBeenCalledExactlyOnceWith({
      repoPath: '/workspace/quarto-cli',
      repoId: 'repo-1'
    })
  })

  it('scopes a host-less persisted fork parent to the origin host', async () => {
    const selectedRepo = makeRepo({
      path: '/workspace/widgets',
      upstream: { owner: 'acme', repo: 'widgets' }
    })
    repoSlug.mockResolvedValue({ owner: 'me', repo: 'widgets', host: 'ghe.example' })

    await expect(
      resolvePaste({
        owner: 'acme',
        repo: 'widgets',
        host: 'ghe.example',
        selectedRepo
      })
    ).resolves.toEqual({ items: [workItem], prompt: null })

    await expect(
      resolvePaste({ owner: 'acme', repo: 'widgets', selectedRepo })
    ).resolves.toMatchObject({ prompt: { matchingRepo: null } })
  })
})
