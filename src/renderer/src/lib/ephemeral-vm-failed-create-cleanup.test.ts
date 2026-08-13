import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorktreeCreationRequest } from '@/lib/pending-worktree-creation'

const store = {
  deleteProjectHostSetup: vi.fn()
}

vi.mock('@/store', () => ({ useAppStore: { getState: () => store } }))

import { cleanupEphemeralVmRuntimeForFailedCreate } from './ephemeral-vm-worktree-creation'

function makeRequest(): WorktreeCreationRequest {
  return {
    repoId: 'repo-runtime',
    name: 'feature',
    setupDecision: 'inherit',
    agent: null,
    pendingFirstAgentMessageRename: false,
    note: '',
    startupPlan: null,
    quickPrompt: '',
    quickTelemetry: null,
    ephemeralVmRuntimeId: 'runtime-1',
    workspaceRunContext: {
      kind: 'workspace-run',
      projectId: 'project-1',
      hostId: 'runtime:env-1',
      projectHostSetupId: 'setup-1',
      repoId: 'repo-runtime',
      path: '/workspace/repo'
    }
  }
}

describe('failed ephemeral VM create cleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    store.deleteProjectHostSetup.mockResolvedValue({})
    globalThis.window = {
      api: { ephemeralVm: { cleanup: vi.fn() } }
    } as never
  })

  it('removes the imported setup before destroying the runtime', async () => {
    const cleanup = vi.mocked(window.api.ephemeralVm.cleanup)

    await cleanupEphemeralVmRuntimeForFailedCreate(makeRequest())

    expect(store.deleteProjectHostSetup).toHaveBeenCalledWith({ setupId: 'setup-1' })
    expect(cleanup).toHaveBeenCalledWith({ runtimeId: 'runtime-1' })
    expect(store.deleteProjectHostSetup.mock.invocationCallOrder[0]).toBeLessThan(
      cleanup.mock.invocationCallOrder[0]!
    )
  })

  it('keeps the runtime when imported setup deletion fails', async () => {
    store.deleteProjectHostSetup.mockResolvedValue(null)

    await cleanupEphemeralVmRuntimeForFailedCreate(makeRequest())

    expect(window.api.ephemeralVm.cleanup).not.toHaveBeenCalled()
  })
})
