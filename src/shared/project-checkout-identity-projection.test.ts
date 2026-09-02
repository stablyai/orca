import { describe, expect, it } from 'vitest'
import {
  getProjectHostSetupsForProject,
  projectHostSetupProjectionFromRepos
} from './project-host-setup-projection'
import type { Repo } from './repo-types'

/** A git repo row with the fields the projection reads; overrides win. */
function repo(overrides: Partial<Repo> & Pick<Repo, 'id' | 'path' | 'displayName'>): Repo {
  return {
    badgeColor: '#737373',
    addedAt: 100,
    kind: 'git',
    ...overrides
  }
}

// Why its own file: a checkout keys on the repo it *is*, while `upstream` and the avatar icon name
// the fork parent or template it descends from — every sibling shares those.
describe('project identity from the checkout remote', () => {
  it('keeps sibling checkouts of one template apart by their own origin remote', () => {
    const template = {
      upstream: { owner: 'TemplateHQ', repo: 'site-template', host: 'github.com' },
      canonicalKey: 'github.com/TemplateHQ/site-template',
      remoteName: 'upstream',
      remoteUrl: 'https://github.com/TemplateHQ/site-template.git'
    }
    const projection = projectHostSetupProjectionFromRepos([
      repo({
        id: 'videotoprompt',
        path: '/Users/alice/sites/videotoprompt.org/src',
        displayName: 'VideoToPrompt.org',
        upstream: template.upstream,
        gitRemoteIdentity: {
          canonicalKey: template.canonicalKey,
          remoteName: template.remoteName,
          remoteUrl: template.remoteUrl,
          origin: {
            canonicalKey: 'github.com/alice/videotoprompt.org',
            remoteUrl: 'https://github.com/alice/videotoprompt.org.git'
          }
        }
      }),
      repo({
        id: 'to-svg',
        path: '/Users/alice/sites/to-svg.com/src',
        displayName: 'src',
        upstream: template.upstream,
        gitRemoteIdentity: {
          canonicalKey: template.canonicalKey,
          remoteName: template.remoteName,
          remoteUrl: template.remoteUrl,
          origin: {
            canonicalKey: 'github.com/alice/to-svg.com',
            remoteUrl: 'https://github.com/alice/to-svg.com.git'
          }
        }
      })
    ])

    expect(projection.projects.map((project) => project.id)).toEqual([
      'github:alice/videotoprompt.org',
      'github:alice/to-svg.com'
    ])
  })

  it('prefers a resolved own remote over stale fork-parent metadata', () => {
    const projection = projectHostSetupProjectionFromRepos([
      repo({
        id: 'submitatool',
        path: '/Users/alice/sites/submitatool.com/src',
        displayName: 'src',
        // Persisted when the template remote still existed; the remote is gone, `upstream` is not.
        upstream: { owner: 'TemplateHQ', repo: 'site-template', host: 'github.com' },
        gitRemoteIdentity: {
          canonicalKey: 'github.com/alice/submitatool.com',
          remoteName: 'origin',
          remoteUrl: 'https://github.com/alice/submitatool.com.git'
        }
      })
    ])

    expect(projection.projects.map((project) => project.id)).toEqual([
      'github:alice/submitatool.com'
    ])
  })

  it('keeps a GHES checkout on the api host its metadata names, whatever the clone url', () => {
    const enterprise = {
      upstream: { owner: 'acme', repo: 'app', host: 'github.acme.test:8443' },
      remoteName: 'origin'
    }
    const projection = projectHostSetupProjectionFromRepos([
      repo({
        id: 'ssh-clone',
        path: '/Users/alice/app',
        displayName: 'app',
        upstream: enterprise.upstream,
        gitRemoteIdentity: {
          canonicalKey: 'github.acme.test/acme/app',
          remoteName: enterprise.remoteName,
          // Why a transport port: SSH clones carry one that the API endpoint does not.
          remoteUrl: 'ssh://git@github.acme.test:2222/acme/app.git'
        }
      }),
      repo({
        id: 'https-clone',
        path: '/srv/app',
        displayName: 'app',
        connectionId: 'build-box',
        upstream: enterprise.upstream,
        gitRemoteIdentity: {
          canonicalKey: 'github.acme.test/acme/app',
          remoteName: enterprise.remoteName,
          remoteUrl: 'https://github.acme.test:8443/acme/app.git'
        }
      })
    ])

    expect(projection.projects.map((project) => project.id)).toEqual([
      'github:github.acme.test:8443/acme/app'
    ])
  })

  it('keeps an HTTPS checkout on its own endpoint port when the metadata names another', () => {
    const projection = projectHostSetupProjectionFromRepos([
      repo({
        id: 'other-endpoint',
        path: '/Users/alice/app',
        displayName: 'app',
        upstream: { owner: 'acme', repo: 'app', host: 'github.acme.test:8443' },
        gitRemoteIdentity: {
          canonicalKey: 'github.acme.test/acme/app',
          remoteName: 'origin',
          // Why: an HTTP(S) port names the API endpoint, so this is a different server than :8443.
          remoteUrl: 'https://github.acme.test:9443/acme/app.git'
        }
      }),
      repo({
        id: 'default-port-metadata',
        path: '/Users/alice/app-2',
        displayName: 'app-2',
        upstream: { owner: 'acme', repo: 'app-2', host: 'github.acme.test' },
        gitRemoteIdentity: {
          canonicalKey: 'github.acme.test/acme/app-2',
          remoteName: 'origin',
          remoteUrl: 'https://github.acme.test:8443/acme/app-2.git'
        }
      })
    ])

    expect(projection.projects.map((project) => project.id)).toEqual([
      'github:github.acme.test:9443/acme/app',
      'github:github.acme.test:8443/acme/app-2'
    ])
  })

  it('ignores an unresolved SSH host alias so the id cannot vary per machine', () => {
    const projection = projectHostSetupProjectionFromRepos([
      repo({
        id: 'aliased',
        path: '/Users/alice/app',
        displayName: 'app',
        upstream: { owner: 'acme', repo: 'app', host: 'github.com' },
        gitRemoteIdentity: {
          // Why: only ~/.ssh/config expands `github-work`, so the literal alias is machine-local.
          canonicalKey: 'github-work/acme/app',
          remoteName: 'origin',
          remoteUrl: 'git@github-work:acme/app.git'
        }
      })
    ])

    expect(projection.projects.map((project) => project.id)).toEqual(['github:acme/app'])
  })

  it('falls back instead of throwing when a persisted identity row is malformed', () => {
    const projection = projectHostSetupProjectionFromRepos([
      repo({
        id: 'malformed',
        path: '/Users/alice/app',
        displayName: 'app',
        upstream: { owner: 'acme', repo: 'app', host: 'github.com' },
        // Why cast: this shape is what a persisted row or an older peer can actually deliver.
        gitRemoteIdentity: { canonicalKey: 42, remoteName: 'origin' } as unknown as NonNullable<
          Repo['gitRemoteIdentity']
        >
      })
    ])

    expect(projection.projects.map((project) => project.id)).toEqual(['github:acme/app'])
  })

  it('keys a fork checkout on its own origin instead of the fork parent', () => {
    const projection = projectHostSetupProjectionFromRepos([
      repo({
        id: 'fork',
        path: '/Users/alice/orca',
        displayName: 'Orca',
        upstream: { owner: 'StablyAI', repo: 'Orca', host: 'github.com' },
        gitRemoteIdentity: {
          canonicalKey: 'github.com/StablyAI/Orca',
          remoteName: 'upstream',
          remoteUrl: 'git@github.com:StablyAI/Orca.git',
          origin: {
            canonicalKey: 'github.com/alice/orca',
            remoteUrl: 'git@github.com:alice/orca.git'
          }
        }
      })
    ])

    expect(projection.projects.map((project) => project.id)).toEqual(['github:alice/orca'])
  })

  it('keys a non-GitHub checkout on its own origin remote', () => {
    const projection = projectHostSetupProjectionFromRepos([
      repo({
        id: 'gitlab-fork',
        path: '/Users/alice/app',
        displayName: 'app',
        gitRemoteIdentity: {
          canonicalKey: 'gitlab.com/team/app',
          remoteName: 'upstream',
          remoteUrl: 'git@gitlab.com:team/app.git',
          origin: {
            canonicalKey: 'gitlab.com/alice/app',
            remoteUrl: 'git@gitlab.com:alice/app.git'
          }
        }
      })
    ])

    expect(projection.projects.map((project) => project.id)).toEqual(['git:gitlab.com/alice/app'])
  })

  it('still groups one fork checkout across hosts by its own origin', () => {
    const forkIdentity = {
      canonicalKey: 'github.com/StablyAI/Orca',
      remoteName: 'upstream',
      remoteUrl: 'git@github.com:StablyAI/Orca.git',
      origin: { canonicalKey: 'github.com/alice/orca', remoteUrl: 'git@github.com:alice/orca.git' }
    }
    const projection = projectHostSetupProjectionFromRepos([
      repo({
        id: 'local-fork',
        path: '/Users/alice/orca',
        displayName: 'Orca',
        gitRemoteIdentity: forkIdentity
      }),
      repo({
        id: 'remote-fork',
        path: '/home/alice/orca',
        displayName: 'orca',
        connectionId: 'gpu-vm',
        gitRemoteIdentity: forkIdentity
      })
    ])

    expect(projection.projects.map((project) => project.id)).toEqual(['github:alice/orca'])
    expect(getProjectHostSetupsForProject(projection.setups, 'github:alice/orca')).toHaveLength(2)
  })
})
