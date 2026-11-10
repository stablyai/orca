import { describe, expect, it } from 'vitest'
import { deriveGitRemoteIdentity } from './git/remotes/git-remote-identity'
import { resolveImportedFolderProjectLink } from './imported-folder-project-identity'

function folder(remoteUrl: string | null) {
  return {
    id: 'imported-repo',
    gitRemoteIdentity: remoteUrl
      ? deriveGitRemoteIdentity(`origin\t${remoteUrl} (fetch)\norigin\t${remoteUrl} (push)\n`)
      : null
  }
}

describe('resolveImportedFolderProjectLink', () => {
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
