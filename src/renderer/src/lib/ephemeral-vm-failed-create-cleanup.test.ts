import { describe, expect, it, vi } from 'vitest'
import type { WorktreeCreationRequest } from '@/lib/pending-worktree-creation'
import { cleanupFailedEphemeralVmWorkspace } from './ephemeral-vm-failed-create-cleanup'

function request(): WorktreeCreationRequest {
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
    ephemeralVmRuntimeId: 'runtime-1',
    ephemeralVmCheckoutMode: 'provisioned-root',
    workspaceRunContext: {
      kind: 'workspace-run',
      projectId: 'project-1',
      hostId: 'ssh:runtime-ssh-1',
      projectHostSetupId: 'setup-1',
      repoId: 'repo-1',
      path: '/workspace/repo'
    }
  }
}

describe('cleanupFailedEphemeralVmWorkspace', () => {
  it('removes the imported project setup before destroying its VM', async () => {
    const order: string[] = []
    await cleanupFailedEphemeralVmWorkspace(request(), {
      deleteProjectHostSetup: vi.fn(async () => {
        order.push('setup')
      }),
      cleanupRuntime: vi.fn(async () => {
        order.push('runtime')
      }),
      reportSetupError: vi.fn(),
      reportRuntimeError: vi.fn()
    })

    expect(order).toEqual(['setup', 'runtime'])
  })

  it('still destroys the VM when setup deletion fails', async () => {
    const cleanupRuntime = vi.fn().mockResolvedValue(undefined)
    const reportSetupError = vi.fn()
    await cleanupFailedEphemeralVmWorkspace(request(), {
      deleteProjectHostSetup: vi.fn().mockRejectedValue(new Error('setup delete failed')),
      cleanupRuntime,
      reportSetupError,
      reportRuntimeError: vi.fn()
    })

    expect(reportSetupError).toHaveBeenCalledOnce()
    expect(cleanupRuntime).toHaveBeenCalledWith('runtime-1')
  })
})
