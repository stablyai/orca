import { describe, expect, it } from 'vitest'
import {
  canOwnOmpRpcSessionLocally,
  resolveOmpRpcPaneExecutionHost,
  type OmpRpcPaneLocalityInput
} from './omp-rpc-pane-locality'

function input(overrides: Partial<OmpRpcPaneLocalityInput> = {}): OmpRpcPaneLocalityInput {
  return { runtimeEnvironmentId: null, connectionId: null, isWebClient: false, ...overrides }
}

describe('resolveOmpRpcPaneExecutionHost', () => {
  it('is local only for a desktop client whose worktree has no owning host', () => {
    expect(resolveOmpRpcPaneExecutionHost(input())).toBe('local')
  })

  it('is runtime for a runtime-owned pane (Model B)', () => {
    expect(resolveOmpRpcPaneExecutionHost(input({ runtimeEnvironmentId: 'env-1' }))).toBe('runtime')
  })

  it('is wsl for a local Windows project configured to execute in WSL', () => {
    expect(
      resolveOmpRpcPaneExecutionHost(
        input({
          projectRuntime: {
            status: 'resolved',
            runtime: {
              kind: 'wsl',
              hostPlatform: 'wsl',
              projectId: 'project-1',
              distro: 'Ubuntu',
              reason: 'project-override',
              cacheKey: 'wsl:Ubuntu'
            }
          }
        })
      )
    ).toBe('wsl')
  })

  // The gap this module closes: runtimeEnvironmentId is null for an `ssh:`
  // worktree, so the old `runtimeEnvironmentId === null` proxy read a Model-A
  // SSH pane as local and let it scan this client's disk for a remote cwd.
  it('is ssh for a Model-A SSH worktree even though it has no runtime owner', () => {
    expect(
      resolveOmpRpcPaneExecutionHost(
        input({ runtimeEnvironmentId: null, connectionId: 'target-1' })
      )
    ).toBe('ssh')
  })

  it('is runtime for a runtime-owned ssh target id', () => {
    expect(resolveOmpRpcPaneExecutionHost(input({ connectionId: 'runtime-ssh-env-1' }))).toBe(
      'runtime'
    )
  })

  it('is unresolved — never local — while the owning repo has not hydrated', () => {
    expect(resolveOmpRpcPaneExecutionHost(input({ connectionId: undefined }))).toBe('unresolved')
  })

  it('is runtime on the web client whatever the worktree claims', () => {
    expect(resolveOmpRpcPaneExecutionHost(input({ isWebClient: true }))).toBe('runtime')
    expect(
      resolveOmpRpcPaneExecutionHost(input({ isWebClient: true, connectionId: undefined }))
    ).toBe('runtime')
  })
})

describe('canOwnOmpRpcSessionLocally', () => {
  it('admits only the local host', () => {
    expect(canOwnOmpRpcSessionLocally('local')).toBe(true)
  })

  it.each(['ssh', 'runtime', 'wsl', 'unresolved'] as const)('refuses %s', (host) => {
    expect(canOwnOmpRpcSessionLocally(host)).toBe(false)
  })
})
