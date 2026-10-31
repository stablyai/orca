import { describe, expect, it } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import { remoteFileBrowserProjectFolders } from './remote-file-browser-project-folders'

function repo(
  path: string,
  executionHostId: Repo['executionHostId'],
  connectionId: string | null = null,
  addedAt = 1
): Pick<Repo, 'path' | 'addedAt' | 'connectionId' | 'executionHostId'> {
  return { path, addedAt, connectionId, executionHostId }
}

describe('remoteFileBrowserProjectFolders', () => {
  const repos = [
    repo('C:\\Users\\me\\code\\orca', 'runtime:env-1'),
    repo('c:\\users\\me\\code\\site', 'runtime:env-1'),
    repo('D:\\scratch\\demo', 'runtime:env-1', null, 9),
    repo('/home/me/work/api', 'runtime:env-1', 'build-box')
  ]

  // A server's own disk and the SSH host it dials share an owner but not a filesystem.
  it("keeps a server's own folders apart from its SSH host's folders", () => {
    expect(remoteFileBrowserProjectFolders(repos, { runtimeEnvironmentId: 'env-1' }, '')).toEqual([
      'C:\\Users\\me\\code',
      'D:\\scratch'
    ])
    expect(
      remoteFileBrowserProjectFolders(
        repos,
        { runtimeEnvironmentId: 'env-1', targetId: 'build-box' },
        '/home/me'
      )
    ).toEqual(['/home/me/work'])
  })

  it('treats Windows paths case-insensitively when leaving out the current folder', () => {
    expect(
      remoteFileBrowserProjectFolders(
        repos,
        { runtimeEnvironmentId: 'env-1' },
        'c:\\USERS\\me\\code'
      )
    ).toEqual(['D:\\scratch'])
  })
})
