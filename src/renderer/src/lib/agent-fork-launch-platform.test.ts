import { describe, expect, it } from 'vitest'
import { getForkAgentLaunchPlatform } from './agent-fork-launch-platform'

describe('getForkAgentLaunchPlatform', () => {
  it('keeps the host platform for a local Windows worktree', () => {
    expect(
      getForkAgentLaunchPlatform({ repo: { connectionId: null }, worktreePath: 'C:\\repo\\fork' })
    ).toBeUndefined()
  })

  it('uses Linux quoting for an SSH worktree', () => {
    expect(
      getForkAgentLaunchPlatform({ repo: { connectionId: 'ssh-1' }, worktreePath: '/home/u/fork' })
    ).toBe('linux')
  })

  it('uses Linux quoting for a WSL UNC worktree path', () => {
    expect(
      getForkAgentLaunchPlatform({
        repo: {},
        worktreePath: '\\\\wsl.localhost\\Ubuntu\\home\\u\\repo\\fork'
      })
    ).toBe('linux')
  })

  it('uses Linux quoting when a Windows-path project resolves to WSL', () => {
    expect(
      getForkAgentLaunchPlatform({
        repo: {},
        worktreePath: 'C:\\repo\\fork',
        projectRuntime: {
          status: 'resolved',
          runtime: {
            kind: 'wsl',
            hostPlatform: 'wsl',
            projectId: 'repo-1',
            distro: 'Ubuntu',
            reason: 'project-override',
            cacheKey: 'repo-1:wsl'
          }
        }
      })
    ).toBe('linux')
  })

  it('follows the preferred runtime while a WSL project needs repair', () => {
    expect(
      getForkAgentLaunchPlatform({
        repo: {},
        worktreePath: 'C:\\repo\\fork',
        projectRuntime: {
          status: 'repair-required',
          repair: {
            projectId: 'repo-1',
            preferredRuntime: { kind: 'wsl', distro: null },
            reason: 'wsl-unavailable',
            source: 'project-override',
            cacheKey: 'repo-1:repair'
          }
        }
      })
    ).toBe('linux')
  })
})
