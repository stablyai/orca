import { describe, expect, it } from 'vitest'
import { resolveNewWorkspaceRepoAgentHost } from './new-workspace-repo-agent-host'

describe('new workspace repo agent host', () => {
  it('uses the runtime owner instead of its nested private SSH target', () => {
    expect(
      resolveNewWorkspaceRepoAgentHost({
        connectionId: 'private-ssh',
        executionHostId: 'runtime:env-9',
        fallbackRuntimeEnvironmentId: 'env-9'
      })
    ).toEqual({ kind: 'runtime', environmentId: 'env-9' })
  })

  it('uses the direct SSH owner', () => {
    expect(
      resolveNewWorkspaceRepoAgentHost({
        connectionId: 'ssh-1',
        executionHostId: 'ssh:ssh-1',
        fallbackRuntimeEnvironmentId: null
      })
    ).toEqual({ kind: 'ssh', connectionId: 'ssh-1' })
  })

  it('uses the focused runtime fallback for a hostless repo', () => {
    expect(
      resolveNewWorkspaceRepoAgentHost({
        connectionId: null,
        executionHostId: null,
        fallbackRuntimeEnvironmentId: 'focused-runtime'
      })
    ).toEqual({ kind: 'runtime', environmentId: 'focused-runtime' })
  })

  it('keeps an explicitly local repo on the client', () => {
    expect(
      resolveNewWorkspaceRepoAgentHost({
        connectionId: null,
        executionHostId: 'local',
        fallbackRuntimeEnvironmentId: null
      })
    ).toEqual({ kind: 'local' })
  })
})
