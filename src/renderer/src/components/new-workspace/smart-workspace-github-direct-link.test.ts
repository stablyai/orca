import { describe, expect, it, vi } from 'vitest'
import { parseGitHubIssueOrPRLink } from '@/lib/github-links'
import type { RepoOption } from './smart-workspace-name-field-model'
import { resolveSmartWorkspaceGithubDirectLink } from './smart-workspace-github-direct-link'

const slugs: Record<string, { owner: string; repo: string; host: string } | null> = {
  'repo-cloud': null,
  'repo-orca': { owner: 'stablyai', repo: 'orca', host: 'github.com' }
}
const repoSlug = vi.fn(async ({ repoId }: { repoId: string }) => slugs[repoId] ?? null)
const workItemByOwnerRepo = vi.fn(async () => null)

// @ts-expect-error focused preload mock
globalThis.window = { api: { gh: { repoSlug, workItemByOwnerRepo } } }

function repo(id: string): RepoOption {
  return { id, path: `/repos/${id}`, displayName: id, badgeColor: '#000000', addedAt: 0 }
}

describe('resolveSmartWorkspaceGithubDirectLink', () => {
  it('offers a project switch when the selected repo has no GitHub origin and the lookup misses', async () => {
    const cloud = repo('repo-cloud')
    const orca = repo('repo-orca')
    const directLink = parseGitHubIssueOrPRLink('https://github.com/stablyai/orca/pull/36891')
    if (!directLink) {
      throw new Error('expected a GitHub PR link')
    }
    const result = await resolveSmartWorkspaceGithubDirectLink({
      directLink,
      crossRepoSwitchTarget: 'project',
      repoBackedSearchTargets: [],
      selectedRepo: cloud,
      githubSourceContext: null,
      repos: [cloud, orca],
      repoSlugCache: new Map(),
      handledCrossRepoUrlRef: { current: null },
      query: 'https://github.com/stablyai/orca/pull/36891'
    })
    expect(result.items).toEqual([])
    expect(result.prompt?.matchingRepo?.id).toBe('repo-orca')
  })
})
