import { describe, expect, it } from 'vitest'
import type { Repo, Worktree } from '../../../shared/types'
import type { AppState } from '@/store/types'
import {
  getLocalAgentPreflightContext,
  getLocalPreflightContext,
  getLocalProjectExecutionRuntimeContext,
  getLocalRepoProjectExecutionRuntimeContext,
  getWslDistroFromPath,
  localPreflightContextKey
} from './local-preflight-context'

function makeState(args: {
  repoPath?: string | null
  worktreePath?: string | null
  repo?: Partial<Repo>
  worktree?: Partial<Worktree>
}): AppState {
  const repoId = 'repo-1'
  const worktreeId = `${repoId}::worktree-1`
  return {
    activeRepoId: repoId,
    activeWorktreeId: args.worktreePath === undefined ? null : worktreeId,
    repos:
      args.repoPath === undefined
        ? []
        : [
            {
              id: repoId,
              path: args.repoPath,
              ...args.repo
            }
          ],
    worktreesByRepo:
      args.worktreePath === undefined
        ? {}
        : {
            [repoId]: [
              {
                id: worktreeId,
                repoId,
                path: args.worktreePath,
                ...args.worktree
              }
            ]
          }
  } as AppState
}

describe('local preflight context', () => {
  it('extracts WSL distro names from supported UNC forms', () => {
    expect(getWslDistroFromPath(String.raw`\\wsl.localhost\Ubuntu\home\alice\repo`)).toBe('Ubuntu')
    expect(getWslDistroFromPath(String.raw`\\wsl$\Debian\home\alice\repo`)).toBe('Debian')
    expect(getWslDistroFromPath('/Users/alice/repo')).toBeNull()
  })

  it('returns a stable snapshot for repeated WSL selector reads', () => {
    const state = makeState({
      repoPath: '/Users/alice/repo',
      worktreePath: String.raw`\\wsl.localhost\Ubuntu\home\alice\repo`
    })

    const first = getLocalPreflightContext(state, 'darwin')
    const second = getLocalPreflightContext(state, 'darwin')

    expect(first).toBe(second)
    expect(first).toEqual({ wslDistro: 'Ubuntu' })
    expect(localPreflightContextKey(first)).toBe('wsl:Ubuntu')
  })

  it('reuses the same WSL snapshot across equivalent active repo and worktree paths', () => {
    const fromRepo = getLocalPreflightContext(
      makeState({
        repoPath: String.raw`\\wsl.localhost\Ubuntu\home\alice\repo`
      }),
      'darwin'
    )
    const fromWorktree = getLocalPreflightContext(
      makeState({
        repoPath: '/Users/alice/repo',
        worktreePath: String.raw`\\wsl.localhost\Ubuntu\home\alice\repo`
      }),
      'darwin'
    )
    const fromOtherDistro = getLocalPreflightContext(
      makeState({
        repoPath: '/Users/alice/repo',
        worktreePath: String.raw`\\wsl.localhost\Debian\home\alice\repo`
      }),
      'darwin'
    )

    expect(fromRepo).toBe(fromWorktree)
    expect(fromOtherDistro).not.toBe(fromRepo)
    expect(fromOtherDistro).toEqual({ wslDistro: 'Debian' })
  })

  it('uses the stable host context for non-WSL paths', () => {
    const state = makeState({ repoPath: '/Users/alice/repo' })

    expect(getLocalPreflightContext(state)).toBeUndefined()
    expect(getLocalPreflightContext(state)).toBeUndefined()
    expect(localPreflightContextKey(getLocalPreflightContext(state))).toBe('host')
  })

  it('keys preflight by active runtime before local WSL or host context', () => {
    const state = {
      ...makeState({
        repoPath: String.raw`\\wsl.localhost\Ubuntu\home\alice\repo`
      }),
      settings: {
        activeRuntimeEnvironmentId: 'runtime-1'
      }
    } as AppState

    const context = getLocalPreflightContext(state)
    expect(context?.runtimeContextKey).toMatch(/^runtime:runtime-1#\d+$/)
    expect(localPreflightContextKey(context)).toBe(context?.runtimeContextKey)
  })

  it('uses the project runtime for Windows local preflight WSL paths', () => {
    const state = makeState({
      repoPath: String.raw`\\wsl.localhost\Ubuntu\home\alice\repo`
    })

    const context = getLocalPreflightContext(state, 'win32')

    expect(context).toEqual({
      wslDistro: 'Ubuntu',
      projectRuntime: {
        status: 'resolved',
        runtime: {
          kind: 'wsl',
          hostPlatform: 'wsl',
          projectId: 'repo-1',
          distro: 'Ubuntu',
          reason: 'project-override',
          cacheKey: 'repo-1:wsl:Ubuntu'
        }
      }
    })
    expect(localPreflightContextKey(context)).toBe('repo-1:wsl:Ubuntu')
  })

  it('uses the project runtime for Windows local preflight host paths', () => {
    const state = makeState({ repoPath: 'C:\\Users\\alice\\repo' })

    const context = getLocalPreflightContext(state, 'win32')

    expect(context).toEqual({
      projectRuntime: {
        status: 'resolved',
        runtime: {
          kind: 'windows-host',
          hostPlatform: 'win32',
          projectId: 'repo-1',
          reason: 'global-default',
          cacheKey: 'repo-1:windows-host'
        }
      }
    })
    expect(localPreflightContextKey(context)).toBe('repo-1:windows-host')
  })

  it('returns repair context for Windows local preflight when the selected WSL distro is missing', () => {
    const state = {
      ...makeState({ repoPath: 'C:\\Users\\alice\\repo' }),
      settings: {
        localWindowsRuntimeDefault: { kind: 'wsl', distro: 'Ubuntu' }
      }
    } as unknown as AppState

    const context = getLocalPreflightContext(state, 'win32', {
      wslAvailable: true,
      availableWslDistros: ['Debian']
    })

    expect(context).toEqual({
      projectRuntime: {
        status: 'repair-required',
        repair: {
          projectId: 'repo-1',
          preferredRuntime: { kind: 'wsl', distro: 'Ubuntu' },
          reason: 'wsl-distro-missing',
          source: 'global-default',
          cacheKey: 'repo-1:repair:wsl-distro-missing:Ubuntu'
        }
      }
    })
    expect(localPreflightContextKey(context)).toBe('repo-1:repair:wsl-distro-missing:Ubuntu')
  })

  it('uses the migrated WSL runtime for local agent checks when WSL is the default shell', () => {
    const state = {
      ...makeState({ repoPath: 'C:\\Users\\alice\\repo' }),
      settings: {
        terminalWindowsShell: 'wsl.exe',
        terminalWindowsWslDistro: 'Debian'
      }
    } as AppState

    const context = getLocalAgentPreflightContext(state, 'win32')

    expect(context).toEqual({
      wslDistro: 'Debian',
      projectRuntime: {
        status: 'resolved',
        runtime: {
          kind: 'wsl',
          hostPlatform: 'wsl',
          projectId: 'repo-1',
          distro: 'Debian',
          reason: 'global-default',
          cacheKey: 'repo-1:wsl:Debian'
        }
      }
    })
    expect(localPreflightContextKey(context)).toBe('repo-1:wsl:Debian')
  })

  it('migrates explicit legacy agent location to the project runtime default', () => {
    const state = {
      ...makeState({ repoPath: 'C:\\Users\\alice\\repo' }),
      settings: {
        terminalWindowsShell: 'wsl.exe',
        terminalWindowsWslDistro: 'Debian',
        localAgentRuntime: 'host'
      }
    } as AppState

    const context = getLocalAgentPreflightContext(state, 'win32')

    expect(context).toEqual({
      projectRuntime: {
        status: 'resolved',
        runtime: {
          kind: 'windows-host',
          hostPlatform: 'win32',
          projectId: 'repo-1',
          reason: 'global-default',
          cacheKey: 'repo-1:windows-host'
        }
      }
    })
    expect(localPreflightContextKey(context)).toBe('repo-1:windows-host')
  })

  it('lets explicit agent location choose a WSL distro independent of the terminal shell', () => {
    const state = {
      ...makeState({ repoPath: 'C:\\Users\\alice\\repo' }),
      settings: {
        terminalWindowsShell: 'powershell.exe',
        localAgentRuntime: 'wsl',
        localAgentWslDistro: 'Ubuntu'
      }
    } as AppState

    const context = getLocalAgentPreflightContext(state, 'win32')

    expect(context).toEqual({
      wslDistro: 'Ubuntu',
      projectRuntime: {
        status: 'resolved',
        runtime: {
          kind: 'wsl',
          hostPlatform: 'wsl',
          projectId: 'repo-1',
          distro: 'Ubuntu',
          reason: 'global-default',
          cacheKey: 'repo-1:wsl:Ubuntu'
        }
      }
    })
    expect(localPreflightContextKey(context)).toBe('repo-1:wsl:Ubuntu')
  })

  it('ignores stale terminal WSL settings when no Windows project runtime is available', () => {
    const state = {
      ...makeState({ repoPath: 'C:\\Users\\alice\\repo' }),
      settings: {
        terminalWindowsShell: 'wsl.exe',
        terminalWindowsWslDistro: 'Debian'
      }
    } as AppState

    expect(getLocalAgentPreflightContext(state, 'linux')).toBeUndefined()
  })

  it('ignores stale explicit agent runtime settings on non-Windows hosts', () => {
    const state = {
      ...makeState({ repoPath: 'C:\\Users\\alice\\repo' }),
      settings: {
        localAgentRuntime: 'wsl',
        localAgentWslDistro: 'Ubuntu'
      }
    } as AppState

    expect(getLocalAgentPreflightContext(state, 'darwin')).toBeUndefined()
  })

  it('returns repair context for explicit WSL agent location without a selected distro', () => {
    const state = {
      ...makeState({ repoPath: 'C:\\Users\\alice\\repo' }),
      settings: {
        terminalWindowsShell: 'powershell.exe',
        localAgentRuntime: 'wsl'
      }
    } as unknown as AppState

    const context = getLocalAgentPreflightContext(state, 'win32')

    expect(context).toEqual({
      projectRuntime: {
        status: 'repair-required',
        repair: {
          projectId: 'repo-1',
          preferredRuntime: { kind: 'wsl', distro: null },
          reason: 'wsl-distro-required',
          source: 'global-default',
          cacheKey: 'repo-1:repair:wsl-distro-required:default'
        }
      }
    })
    expect(localPreflightContextKey(context)).toBe('repo-1:repair:wsl-distro-required:default')
  })

  it('uses the global WSL runtime for local agent checks without an active project', () => {
    const state = {
      ...makeState({ repoPath: undefined }),
      activeRepoId: null,
      activeWorktreeId: null,
      settings: {
        localWindowsRuntimeDefault: { kind: 'wsl', distro: 'Ubuntu' }
      }
    } as unknown as AppState

    const context = getLocalAgentPreflightContext(state, 'win32')

    expect(context).toEqual({
      wslDistro: 'Ubuntu',
      projectRuntime: {
        status: 'resolved',
        runtime: {
          kind: 'wsl',
          hostPlatform: 'wsl',
          projectId: 'local-project',
          distro: 'Ubuntu',
          reason: 'global-default',
          cacheKey: 'local-project:wsl:Ubuntu'
        }
      }
    })
    expect(localPreflightContextKey(context)).toBe('local-project:wsl:Ubuntu')
  })

  it('uses the global runtime default over stale legacy agent location without an active project', () => {
    const state = {
      ...makeState({ repoPath: undefined }),
      activeRepoId: null,
      activeWorktreeId: null,
      settings: {
        localAgentRuntime: 'host',
        localWindowsRuntimeDefault: { kind: 'wsl', distro: 'Ubuntu' }
      }
    } as unknown as AppState

    const context = getLocalAgentPreflightContext(state, 'win32')

    expect(localPreflightContextKey(context)).toBe('local-project:wsl:Ubuntu')
  })

  it('does not use the global runtime default for active SSH projects', () => {
    const state = {
      ...makeState({
        repoPath: '/home/alice/repo',
        repo: { connectionId: 'builder', executionHostId: 'ssh:builder' }
      }),
      settings: {
        localWindowsRuntimeDefault: { kind: 'wsl', distro: 'Ubuntu' }
      }
    } as unknown as AppState

    expect(getLocalAgentPreflightContext(state, 'win32')).toBeUndefined()
  })

  it('uses the project override over legacy agent location for local agent checks', () => {
    const state = {
      ...makeState({ repoPath: 'C:\\Users\\alice\\repo' }),
      settings: {
        localWindowsRuntimeDefault: { kind: 'wsl', distro: 'Ubuntu' },
        localAgentRuntime: 'wsl',
        localAgentWslDistro: 'Ubuntu'
      },
      projects: [{ id: 'repo-1', localWindowsRuntimePreference: { kind: 'windows-host' } }]
    } as unknown as AppState

    const context = getLocalAgentPreflightContext(state, 'win32')

    expect(context).toEqual({
      projectRuntime: {
        status: 'resolved',
        runtime: {
          kind: 'windows-host',
          hostPlatform: 'win32',
          projectId: 'repo-1',
          reason: 'project-override',
          cacheKey: 'repo-1:windows-host'
        }
      }
    })
  })

  it('uses the target worktree runtime for local agent checks', () => {
    const state = {
      ...makeState({
        repoPath: 'C:\\Users\\alice\\active',
        worktreePath: 'C:\\Users\\alice\\active'
      }),
      repos: [
        { id: 'repo-1', path: 'C:\\Users\\alice\\active' },
        { id: 'repo-2', path: 'C:\\Users\\alice\\target' }
      ],
      worktreesByRepo: {
        'repo-1': [
          {
            id: 'repo-1::worktree-1',
            repoId: 'repo-1',
            path: 'C:\\Users\\alice\\active'
          }
        ],
        'repo-2': [
          {
            id: 'repo-2::worktree-1',
            repoId: 'repo-2',
            path: 'C:\\Users\\alice\\target'
          }
        ]
      },
      projects: [
        { id: 'repo-1', localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' } },
        { id: 'repo-2', localWindowsRuntimePreference: { kind: 'windows-host' } }
      ]
    } as unknown as AppState

    const context = getLocalAgentPreflightContext(state, 'win32', {}, 'repo-2::worktree-1')

    expect(localPreflightContextKey(context)).toBe('repo-2:windows-host')
  })

  it('resolves a project host override for a specific worktree over a WSL default', () => {
    const state = {
      ...makeState({ repoPath: 'C:\\Users\\alice\\repo', worktreePath: 'C:\\Users\\alice\\repo' }),
      settings: {
        terminalWindowsShell: 'wsl.exe',
        terminalWindowsWslDistro: 'Debian',
        localWindowsRuntimeDefault: { kind: 'wsl', distro: 'Debian' }
      },
      projects: [{ id: 'repo-1', localWindowsRuntimePreference: { kind: 'windows-host' } }]
    } as unknown as AppState

    expect(getLocalProjectExecutionRuntimeContext(state, 'repo-1::worktree-1', 'win32')).toEqual({
      status: 'resolved',
      runtime: {
        kind: 'windows-host',
        hostPlatform: 'win32',
        projectId: 'repo-1',
        reason: 'project-override',
        cacheKey: 'repo-1:windows-host'
      }
    })
  })

  it('resolves WSL UNC worktrees to their owning distro when the project inherits host default', () => {
    const state = makeState({
      repoPath: 'C:\\Users\\alice\\repo',
      worktreePath: '\\\\wsl.localhost\\Ubuntu\\home\\alice\\repo'
    })

    expect(getLocalProjectExecutionRuntimeContext(state, 'repo-1::worktree-1', 'win32')).toEqual({
      status: 'resolved',
      runtime: {
        kind: 'wsl',
        hostPlatform: 'wsl',
        projectId: 'repo-1',
        distro: 'Ubuntu',
        reason: 'project-override',
        cacheKey: 'repo-1:wsl:Ubuntu'
      }
    })
  })

  it('resolves a local repo project WSL override before a worktree exists', () => {
    const state = {
      ...makeState({ repoPath: String.raw`C:\Users\alice\repo` }),
      projects: [
        {
          id: 'project-1',
          sourceRepoIds: ['repo-1'],
          localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' }
        }
      ]
    } as unknown as AppState

    expect(getLocalRepoProjectExecutionRuntimeContext(state, 'repo-1', 'win32')).toEqual({
      status: 'resolved',
      runtime: {
        kind: 'wsl',
        hostPlatform: 'wsl',
        projectId: 'project-1',
        distro: 'Ubuntu',
        reason: 'project-override',
        cacheKey: 'project-1:wsl:Ubuntu'
      }
    })
  })

  it('resolves a local repo WSL UNC path before a worktree exists', () => {
    const state = makeState({
      repoPath: String.raw`\\wsl.localhost\Ubuntu\home\alice\repo`
    })

    expect(getLocalRepoProjectExecutionRuntimeContext(state, 'repo-1', 'win32')).toEqual({
      status: 'resolved',
      runtime: {
        kind: 'wsl',
        hostPlatform: 'wsl',
        projectId: 'repo-1',
        distro: 'Ubuntu',
        reason: 'project-override',
        cacheKey: 'repo-1:wsl:Ubuntu'
      }
    })
  })

  it('does not create a local project runtime for SSH repos', () => {
    const state = makeState({
      repoPath: 'C:\\Users\\alice\\repo',
      repo: { connectionId: 'builder', executionHostId: 'ssh:builder' }
    })

    expect(getLocalProjectExecutionRuntimeContext(state, undefined, 'win32')).toBeUndefined()
    expect(getLocalRepoProjectExecutionRuntimeContext(state, 'repo-1', 'win32')).toBeUndefined()
    expect(getLocalPreflightContext(state, 'win32')).toBeUndefined()
  })

  it('uses the requested worktree repo owner before resolving a local project runtime', () => {
    const state = {
      ...makeState({
        repoPath: 'C:\\Users\\alice\\repo',
        worktreePath: 'C:\\Users\\alice\\repo'
      }),
      repos: [
        {
          id: 'repo-1',
          path: 'C:\\Users\\alice\\repo',
          executionHostId: 'local'
        },
        {
          id: 'repo-ssh',
          path: '/remote/repo',
          connectionId: 'builder',
          executionHostId: 'ssh:builder'
        }
      ],
      worktreesByRepo: {
        'repo-1': [
          {
            id: 'repo-1::worktree-1',
            repoId: 'repo-1',
            path: 'C:\\Users\\alice\\repo'
          }
        ],
        'repo-ssh': [
          {
            id: 'repo-ssh::worktree-1',
            repoId: 'repo-ssh',
            path: '/remote/repo',
            hostId: 'ssh:builder'
          }
        ]
      }
    } as unknown as AppState

    expect(getLocalProjectExecutionRuntimeContext(state, 'repo-ssh::worktree-1', 'win32')).toBe(
      undefined
    )
  })

  it('returns repair when the resolved project WSL distro is unavailable', () => {
    const state = {
      ...makeState({ repoPath: 'C:\\Users\\alice\\repo', worktreePath: 'C:\\Users\\alice\\repo' }),
      settings: {
        localWindowsRuntimeDefault: { kind: 'windows-host' }
      },
      projects: [{ id: 'repo-1', localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' } }]
    } as unknown as AppState

    expect(
      getLocalProjectExecutionRuntimeContext(state, 'repo-1::worktree-1', 'win32', {
        wslAvailable: true,
        availableWslDistros: ['Debian']
      })
    ).toEqual({
      status: 'repair-required',
      repair: {
        projectId: 'repo-1',
        preferredRuntime: { kind: 'wsl', distro: 'Ubuntu' },
        reason: 'wsl-distro-missing',
        source: 'project-override',
        cacheKey: 'repo-1:repair:wsl-distro-missing:Ubuntu'
      }
    })
  })

  it('defers WSL repair while capability loading leaves distro availability unknown', () => {
    const state = {
      ...makeState({ repoPath: 'C:\\Users\\alice\\repo', worktreePath: 'C:\\Users\\alice\\repo' }),
      settings: {
        localWindowsRuntimeDefault: { kind: 'wsl', distro: 'Ubuntu' }
      }
    } as unknown as AppState

    expect(
      getLocalProjectExecutionRuntimeContext(state, 'repo-1::worktree-1', 'win32', {
        wslAvailable: undefined,
        availableWslDistros: null
      })
    ).toEqual({
      status: 'resolved',
      runtime: {
        kind: 'wsl',
        hostPlatform: 'wsl',
        projectId: 'repo-1',
        distro: 'Ubuntu',
        reason: 'global-default',
        cacheKey: 'repo-1:wsl:Ubuntu'
      }
    })
  })

  it('resolves the requested worktree instead of the active worktree', () => {
    const state = {
      ...makeState({
        repoPath: 'C:\\Users\\alice\\repo',
        worktreePath: '\\\\wsl.localhost\\Ubuntu\\home\\alice\\repo'
      }),
      activeWorktreeId: 'repo-1::worktree-1',
      worktreesByRepo: {
        'repo-1': [
          {
            id: 'repo-1::worktree-1',
            repoId: 'repo-1',
            path: '\\\\wsl.localhost\\Ubuntu\\home\\alice\\repo'
          },
          {
            id: 'repo-1::host-worktree',
            repoId: 'repo-1',
            path: 'C:\\Users\\alice\\repo'
          }
        ]
      },
      settings: {
        localWindowsRuntimeDefault: { kind: 'windows-host' }
      }
    } as unknown as AppState

    expect(getLocalProjectExecutionRuntimeContext(state, 'repo-1::host-worktree', 'win32')).toEqual(
      {
        status: 'resolved',
        runtime: {
          kind: 'windows-host',
          hostPlatform: 'win32',
          projectId: 'repo-1',
          reason: 'global-default',
          cacheKey: 'repo-1:windows-host'
        }
      }
    )
  })
})
