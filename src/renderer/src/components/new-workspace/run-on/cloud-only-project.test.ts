import { describe, expect, it } from 'vitest'
import {
  isRemoteServerProject,
  pickCloudOnlyRepository,
  remoteServerProjectGitHubKey
} from './cloud-only-project'

const remote = (url: string | null, extra: Record<string, unknown> = {}) => ({
  kind: 'git' as const,
  connectionId: null,
  executionHostId: 'runtime:env-p57-3',
  gitRemoteIdentity: url ? { remoteUrl: url } : null,
  ...extra
})

const listed = [
  {
    fullName: 'octocat/Hello-World',
    url: 'https://github.com/octocat/Hello-World',
    private: false
  },
  { fullName: 'acme/web', url: 'https://github.com/acme/web', private: true }
]

describe('remote-server projects (RUNON-NO-NEW-SANDBOX)', () => {
  it('is a project cloned only on a remote Orca server, never this computer, SSH or a folder', () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the fields the check reads.
    const as = (value: unknown) => value as Parameters<typeof isRemoteServerProject>[0]
    expect(isRemoteServerProject(as(remote('https://github.com/octocat/Hello-World')))).toBe(true)
    expect(
      isRemoteServerProject(
        as(remote('https://github.com/octocat/Hello-World', { executionHostId: 'local' }))
      )
    ).toBe(false)
    expect(
      isRemoteServerProject(
        as(remote('https://github.com/octocat/Hello-World', { connectionId: 'ssh-1' }))
      )
    ).toBe(false)
    expect(isRemoteServerProject(as(remote(null, { kind: 'folder' })))).toBe(false)
    expect(isRemoteServerProject(null)).toBe(false)
  })

  it("reads the project's GitHub repository from its remote", () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the fields the check reads.
    const as = (value: unknown) => value as Parameters<typeof remoteServerProjectGitHubKey>[0]
    expect(remoteServerProjectGitHubKey(as(remote('git@github.com:octocat/Hello-World.git')))).toBe(
      'octocat/hello-world'
    )
    expect(remoteServerProjectGitHubKey(as(remote('https://gitlab.com/a/b')))).toBeNull()
    expect(remoteServerProjectGitHubKey(as(remote(null)))).toBeNull()
  })

  it("picks the project's own repository when Orca Cloud can reach it, and a person's pick wins", () => {
    expect(pickCloudOnlyRepository(listed, null, 'octocat/hello-world')?.fullName).toBe(
      'octocat/Hello-World'
    )
    expect(pickCloudOnlyRepository(listed, 'acme/web', 'octocat/hello-world')?.fullName).toBe(
      'acme/web'
    )
  })

  it('picks nothing when the repository is not reachable yet (the picker and More access remain)', () => {
    expect(pickCloudOnlyRepository(listed, null, 'octocat/spoon-knife')).toBeNull()
    expect(pickCloudOnlyRepository(null, null, 'octocat/hello-world')).toBeNull()
    expect(pickCloudOnlyRepository(listed, null, null)).toBeNull()
  })
})
