import { describe, expect, it, vi } from 'vitest'

vi.mock('./new-workspace', () => ({ CLIENT_PLATFORM: 'darwin' }))

describe('resolveSourceControlLaunchPlatform', () => {
  it('uses linux shell planning for ssh POSIX paths and local WSL paths', async () => {
    const { resolveSourceControlLaunchPlatform } = await import('./source-control-launch-platform')

    expect(
      resolveSourceControlLaunchPlatform({
        connectionId: 'ssh-1',
        worktreePath: '/home/alice/repo'
      })
    ).toBe('linux')
    expect(
      resolveSourceControlLaunchPlatform({
        connectionId: null,
        worktreePath: String.raw`\\wsl.localhost\Ubuntu\home\alice\repo`
      })
    ).toBe('linux')
  })

  it('uses windows shell planning for ssh Windows paths', async () => {
    const { resolveSourceControlLaunchPlatform } = await import('./source-control-launch-platform')

    expect(
      resolveSourceControlLaunchPlatform({
        connectionId: 'ssh-1',
        worktreePath: String.raw`C:\Users\alice\repo`
      })
    ).toBe('win32')
  })
})
