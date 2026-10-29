import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../../../shared/repo-types'
import { githubAvatarIcon } from '../../../../../../shared/repo-icon'
import {
  buildRepositoryGitHubAvatarUpdate,
  resolveRepositoryGitHubAvatar
} from './repository-icon-github'

vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: vi.fn() }))

const apiMocks = {
  repoSlug: vi.fn(),
  repoUpstream: vi.fn()
}

// @ts-expect-error test window mock
globalThis.window = { api: { gh: apiMocks } }

function makeRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 'repo-1',
    path: '/workspace/orca',
    displayName: 'orca',
    badgeColor: '#2563eb',
    addedAt: 1,
    kind: 'git',
    ...overrides
  }
}

describe('repository GitHub avatar resolution', () => {
  beforeEach(() => {
    apiMocks.repoSlug.mockReset()
    apiMocks.repoUpstream.mockReset()
  })

  it('uses stored upstream by default and keeps the parent avatar for same-name forks', async () => {
    const repo = makeRepo({ upstream: { owner: 'stablyai', repo: 'orca' } })
    // The fork's own origin owner — same repo name, so the parent avatar wins.
    apiMocks.repoSlug.mockResolvedValueOnce({ owner: 'tmchow', repo: 'orca' })

    await expect(resolveRepositoryGitHubAvatar({ kind: 'local' }, repo)).resolves.toEqual({
      repoIcon: {
        type: 'image',
        src: 'https://github.com/stablyai.png?size=64',
        source: 'github',
        label: 'stablyai/orca'
      },
      upstream: { owner: 'stablyai', repo: 'orca' }
    })

    expect(apiMocks.repoUpstream).not.toHaveBeenCalled()
    expect(apiMocks.repoSlug).toHaveBeenCalledExactlyOnceWith({
      repoPath: '/workspace/orca',
      repoId: 'repo-1'
    })
  })

  it('prefers the renamed fork own owner over the stored upstream', async () => {
    const repo = makeRepo({ upstream: { owner: 'upstream-org', repo: 'rocket' } })
    apiMocks.repoUpstream.mockResolvedValueOnce({ owner: 'upstream-org', repo: 'rocket' })
    apiMocks.repoSlug.mockResolvedValueOnce({ owner: 'acme', repo: 'rocket-pro' })

    const resolution = await resolveRepositoryGitHubAvatar({ kind: 'local' }, repo, {
      forceLive: true
    })

    expect(resolution).toEqual({
      repoIcon: {
        type: 'image',
        src: 'https://github.com/acme.png?size=64',
        source: 'github',
        label: 'acme/rocket-pro'
      },
      upstream: { owner: 'upstream-org', repo: 'rocket' }
    })
    expect(buildRepositoryGitHubAvatarUpdate(repo, resolution)).toEqual({
      repoIcon: {
        type: 'image',
        src: 'https://github.com/acme.png?size=64',
        source: 'github',
        label: 'acme/rocket-pro'
      }
    })
  })

  it('force-resolves the live origin owner when a non-fork repo was transferred', async () => {
    // Force live origin lookup after a non-fork transfer so cached owner avatars can advance.
    const repo = makeRepo({
      upstream: null,
      repoIcon: {
        type: 'image',
        src: 'https://github.com/stablyai.png?size=64',
        source: 'github',
        label: 'stablyai/orca'
      }
    })
    apiMocks.repoUpstream.mockResolvedValueOnce(null)
    apiMocks.repoSlug.mockResolvedValueOnce({ owner: 'parkerrex', repo: 'orca' })

    const resolution = await resolveRepositoryGitHubAvatar({ kind: 'local' }, repo, {
      forceLive: true
    })

    expect(resolution).toEqual({
      repoIcon: {
        type: 'image',
        src: 'https://github.com/parkerrex.png?size=64',
        source: 'github',
        label: 'parkerrex/orca'
      },
      upstream: null
    })
    expect(apiMocks.repoUpstream).toHaveBeenCalledExactlyOnceWith({
      repoPath: '/workspace/orca',
      repoId: 'repo-1'
    })
    expect(apiMocks.repoSlug).toHaveBeenCalledExactlyOnceWith({
      repoPath: '/workspace/orca',
      repoId: 'repo-1'
    })
    expect(buildRepositoryGitHubAvatarUpdate(repo, resolution)).toEqual({
      repoIcon: {
        type: 'image',
        src: 'https://github.com/parkerrex.png?size=64',
        source: 'github',
        label: 'parkerrex/orca'
      }
    })
  })

  it('does not clear a GitHub avatar on passive refresh when live slug is unavailable', async () => {
    const repo = makeRepo({
      repoIcon: {
        type: 'image',
        src: 'https://github.com/stablyai.png?size=64',
        source: 'github',
        label: 'stablyai/orca'
      }
    })

    expect(buildRepositoryGitHubAvatarUpdate(repo, { repoIcon: null, upstream: null })).toEqual({
      upstream: null
    })
    expect(
      buildRepositoryGitHubAvatarUpdate(
        repo,
        { repoIcon: null, upstream: null },
        {
          clearMissingIcon: true
        }
      )
    ).toEqual({
      upstream: null,
      repoIcon: null
    })
  })

  it('preserves a known fork identity when the live upstream lookup fails', async () => {
    // Failed live upstream probes must preserve known fork parents instead of falling back to origin.
    const repo = makeRepo({
      upstream: { owner: 'stablyai', repo: 'orca' },
      repoIcon: {
        type: 'image',
        src: 'https://github.com/stablyai.png?size=64',
        source: 'github',
        label: 'stablyai/orca'
      }
    })
    apiMocks.repoUpstream.mockResolvedValueOnce(null)
    apiMocks.repoSlug.mockResolvedValueOnce({ owner: 'parkerrex', repo: 'orca' })

    const resolution = await resolveRepositoryGitHubAvatar({ kind: 'local' }, repo, {
      forceLive: true
    })

    expect(resolution).toEqual({
      repoIcon: {
        type: 'image',
        src: 'https://github.com/stablyai.png?size=64',
        source: 'github',
        label: 'stablyai/orca'
      },
      upstream: { owner: 'stablyai', repo: 'orca' }
    })
    expect(buildRepositoryGitHubAvatarUpdate(repo, resolution)).toBeNull()
  })

  it('propagates an ambiguous origin probe failure instead of flipping to the parent avatar', async () => {
    // Ambiguous origin failures cannot distinguish renamed forks; propagate so callers retain the stored icon.
    const repo = makeRepo({
      upstream: { owner: 'upstream-org', repo: 'rocket' },
      repoIcon: githubAvatarIcon({ owner: 'acme', repo: 'rocket-pro' })
    })
    apiMocks.repoUpstream.mockResolvedValueOnce({ owner: 'upstream-org', repo: 'rocket' })
    apiMocks.repoSlug.mockRejectedValueOnce(new Error('runtime rpc timeout'))

    await expect(
      resolveRepositoryGitHubAvatar({ kind: 'local' }, repo, { forceLive: true })
    ).rejects.toThrow('runtime rpc timeout')
  })

  it('persists an upstream change when only the GitHub host differs', () => {
    const repo = makeRepo({
      upstream: { owner: 'acme', repo: 'widgets', host: 'github.com' }
    })
    const enterprise = { owner: 'acme', repo: 'widgets', host: 'github.acme.test' }

    expect(
      buildRepositoryGitHubAvatarUpdate(repo, {
        repoIcon: githubAvatarIcon(enterprise),
        upstream: enterprise
      })
    ).toMatchObject({ upstream: enterprise })
  })
})
