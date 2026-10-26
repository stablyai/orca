import { describe, expect, it } from 'vitest'
import { deriveGitRemoteIdentity } from './git-remote-identity'
import { resolveImportedFolderProjectLink } from './imported-folder-project-identity'
import { getProjectIdentityKey } from './project-host-setup-projection'

function folder(remoteUrl: string | null) {
  return {
    gitRemoteIdentity: remoteUrl
      ? deriveGitRemoteIdentity(`origin\t${remoteUrl} (fetch)\norigin\t${remoteUrl} (push)\n`)
      : null
  }
}

/** The project a source host derives for a repo with this remote. */
function projectIdFor(remoteUrl: string): string {
  return getProjectIdentityKey({ id: 'source-repo', ...folder(remoteUrl) })
}

describe('resolveImportedFolderProjectLink', () => {
  it('stamps a GitHub project as upstream', () => {
    expect(
      resolveImportedFolderProjectLink(folder(null), 'github:acme/orca', {
        provider: 'github',
        owner: 'acme',
        repo: 'orca'
      })
    ).toEqual({ upstream: { owner: 'acme', repo: 'orca' } })
  })

  it.each([
    ['GitLab over HTTPS', 'https://gitlab.com/group/sub/app.git'],
    ['GitLab over SSH', 'git@gitlab.com:group/sub/app.git'],
    ['a self-hosted host over ssh://', 'ssh://git@git.example.test:2222/team/app.git'],
    ['a generic HTTPS host', 'https://git.example.test/team/app']
  ])('links %s through the folder remote', (_label, remoteUrl) => {
    const link = resolveImportedFolderProjectLink(
      folder(remoteUrl),
      projectIdFor(remoteUrl),
      undefined
    )
    expect(link).toEqual({ gitRemoteIdentity: folder(remoteUrl).gitRemoteIdentity })
  })

  it('treats the SSH and HTTPS forms of one repository as the same project', () => {
    const projectId = projectIdFor('https://gitlab.com/group/app.git')
    expect(
      resolveImportedFolderProjectLink(folder('git@gitlab.com:group/app.git'), projectId, undefined)
    ).toHaveProperty('gitRemoteIdentity')
  })

  it('refuses a folder whose remote names another repository', () => {
    expect(() =>
      resolveImportedFolderProjectLink(
        folder('https://gitlab.com/group/other.git'),
        projectIdFor('https://gitlab.com/group/app.git'),
        undefined
      )
    ).toThrow('Imported folder does not match the selected project identity.')
  })

  it('refuses a folder with no remote for a Git-remote project', () => {
    expect(() =>
      resolveImportedFolderProjectLink(
        folder(null),
        projectIdFor('https://gitlab.com/group/app.git'),
        undefined
      )
    ).toThrow('Imported folder does not match the selected project identity.')
  })

  it('still refuses a GitHub remote that names another repository', () => {
    expect(() =>
      resolveImportedFolderProjectLink(
        folder('https://github.com/acme/other.git'),
        'github:acme/orca',
        {
          provider: 'github',
          owner: 'acme',
          repo: 'orca'
        }
      )
    ).toThrow('its Git remote "origin" points at acme/other')
  })
})
