import { describe, expect, it } from 'vitest'
import type { WorktreeCreationRequest } from './pending-worktree-creation'
import { getProvisionedRootCreateOptions } from './provisioned-root-create-options'

function request(overrides: Partial<WorktreeCreationRequest> = {}): WorktreeCreationRequest {
  return {
    repoId: 'repo-1',
    name: 'feature',
    setupDecision: 'inherit',
    agent: null,
    pendingFirstAgentMessageRename: false,
    note: '',
    startupPlan: null,
    quickPrompt: '',
    quickTelemetry: null,
    ...overrides
  }
}

describe('getProvisionedRootCreateOptions', () => {
  it('leaves ordinary workspace creation unchanged', () => {
    expect(getProvisionedRootCreateOptions(request())).toBeNull()
  })

  it('returns the main-owned adoption identity', () => {
    expect(
      getProvisionedRootCreateOptions(
        request({
          ephemeralVmCheckoutMode: 'provisioned-root',
          ephemeralVmRuntimeId: 'runtime-1',
          ephemeralVmExpectedRefHead: 'abc123',
          workspaceRunContext: {
            kind: 'workspace-run',
            projectId: 'project-1',
            hostId: 'ssh:runtime-ssh-one',
            projectHostSetupId: 'setup-1',
            repoId: 'repo-runtime',
            path: '/workspace/repo'
          }
        })
      )
    ).toEqual({
      runtimeId: 'runtime-1',
      executionHostId: 'ssh:runtime-ssh-one',
      expectedPath: '/workspace/repo',
      expectedRefHead: 'abc123'
    })
  })

  it('rejects incomplete provisioned-root identity', () => {
    expect(() =>
      getProvisionedRootCreateOptions(
        request({ ephemeralVmCheckoutMode: 'provisioned-root', ephemeralVmRuntimeId: 'runtime-1' })
      )
    ).toThrow('identity is incomplete')

    expect(() =>
      getProvisionedRootCreateOptions(
        request({
          ephemeralVmCheckoutMode: 'provisioned-root',
          ephemeralVmRuntimeId: 'runtime-1',
          baseBranch: 'origin/main',
          workspaceRunContext: {
            kind: 'workspace-run',
            projectId: 'project-1',
            hostId: 'ssh:runtime-ssh-one',
            projectHostSetupId: 'setup-1',
            repoId: 'repo-runtime',
            path: '/workspace/repo'
          }
        })
      )
    ).toThrow('identity is incomplete')
  })
})
