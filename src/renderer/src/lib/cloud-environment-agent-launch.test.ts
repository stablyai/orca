import { describe, expect, it, vi } from 'vitest'

vi.mock('./environment-setup-agent-launch', () => ({
  launchSetupAgentWithPrompt: vi.fn(),
  pickEnvironmentSetupRepo: (repos: { id: string }[], activeRepoId: string | null) =>
    repos.find((repo) => repo.id === activeRepoId) ?? repos[0] ?? null
}))

import { githubSlugForRepo, pickCloudEnvironmentAgentRepo } from './cloud-environment-agent-launch'
import type { Repo } from '../../../shared/repo-types'

function repo(id: string, canonicalKey: string | null): Repo {
  return {
    id,
    path: `/src/${id}`,
    displayName: id,
    badgeColor: '#000',
    addedAt: 0,
    kind: 'git',
    gitRemoteIdentity: canonicalKey
      ? {
          canonicalKey,
          remoteName: 'origin',
          remoteUrl: `https://${canonicalKey}.git`
        }
      : null
  }
}

describe('pickCloudEnvironmentAgentRepo', () => {
  const repos = [
    repo('other', 'github.com/acme/other'),
    repo('api', 'github.com/acme/api'),
    repo('web', 'github.com/Acme/Web')
  ]

  it('prefers the first environment repo with a matching GitHub remote', () => {
    expect(
      pickCloudEnvironmentAgentRepo(
        repos,
        ['https://github.com/acme/web.git', 'https://github.com/acme/api.git'],
        'other'
      )?.id
    ).toBe('web')
  })

  it('falls back to the active project', () => {
    expect(
      pickCloudEnvironmentAgentRepo(repos, ['https://github.com/acme/none.git'], 'api')?.id
    ).toBe('api')
  })

  it('reads GitHub slugs from remote identities', () => {
    expect(githubSlugForRepo(repo('x', 'github.com/acme/web'))).toBe('acme/web')
    expect(githubSlugForRepo(repo('x', 'gitlab.com/acme/web'))).toBeNull()
    expect(githubSlugForRepo(repo('x', null))).toBeNull()
  })
})
