import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  activateAndRevealFolderWorkspace: vi.fn(),
  activateAndRevealWorktree: vi.fn(),
  setEphemeralVmWorkspaceWaking: vi.fn(),
  refreshEphemeralVmRuntimes: vi.fn(async () => undefined),
  toastError: vi.fn((_title: string, _options?: { description?: string }) => undefined)
}))

vi.mock('@/store/index', () => ({
  useAppStore: {
    getState: () => ({
      ephemeralVmRuntimesByWorkspaceId: {
        'wt-vm': { id: 'vm-1', workspaceId: 'wt-vm', status: 'suspended' }
      },
      setEphemeralVmWorkspaceWaking: mocks.setEphemeralVmWorkspaceWaking,
      refreshEphemeralVmRuntimes: mocks.refreshEphemeralVmRuntimes
    })
  }
}))

vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }))

vi.mock('@/lib/workspace/activation/worktree-activation', () => ({
  activateAndRevealFolderWorkspace: mocks.activateAndRevealFolderWorkspace,
  activateAndRevealWorktree: mocks.activateAndRevealWorktree
}))

import { activateWorktreeFromSidebar } from './sidebar-worktree-activation'
import type { EphemeralVmWorkspaceLifecycleResult as ResumeResult } from '../../../../../shared/ephemeral-vm-runtimes'

describe('sidebar worktree activation', () => {
  beforeEach(() => {
    mocks.activateAndRevealWorktree.mockClear()
    mocks.activateAndRevealFolderWorkspace.mockClear()
    mocks.setEphemeralVmWorkspaceWaking.mockClear()
    mocks.refreshEphemeralVmRuntimes.mockClear()
    mocks.toastError.mockClear()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('marks the VM waking until the settled record is read', async () => {
    let resolveResume: ((value: ResumeResult) => void) | undefined
    const resumeWorkspace = vi.fn(
      () =>
        new Promise<ResumeResult>((resolve) => {
          resolveResume = resolve
        })
    )
    vi.stubGlobal('window', { api: { ephemeralVm: { resumeWorkspace } } })

    const activation = activateWorktreeFromSidebar('wt-vm')
    await vi.waitFor(() =>
      expect(mocks.setEphemeralVmWorkspaceWaking).toHaveBeenCalledWith('wt-vm', true)
    )
    expect(mocks.setEphemeralVmWorkspaceWaking).not.toHaveBeenCalledWith('wt-vm', false)

    resolveResume?.({ ok: true, runtime: null })
    await activation
    expect(mocks.setEphemeralVmWorkspaceWaking).toHaveBeenLastCalledWith('wt-vm', false)
  })

  it('clears waking and reports when resume fails', async () => {
    const resumeWorkspace = vi.fn(async () => {
      throw new Error('resume command exited 1')
    })
    vi.stubGlobal('window', { api: { ephemeralVm: { resumeWorkspace } } })

    await activateWorktreeFromSidebar('wt-vm')

    expect(mocks.toastError).toHaveBeenCalledTimes(1)
    expect(mocks.setEphemeralVmWorkspaceWaking).toHaveBeenLastCalledWith('wt-vm', false)
  })

  it('renders a coded resume failure through the failure catalog', async () => {
    const failure = {
      error: 'Resume exited with code 3.',
      errorCode: 'resumeExited',
      errorParams: { exitCode: 3 }
    }
    const resumeWorkspace = vi.fn(async (): Promise<ResumeResult> => ({ ok: false, ...failure }))
    vi.stubGlobal('window', { api: { ephemeralVm: { resumeWorkspace } } })

    await activateWorktreeFromSidebar('wt-vm')

    expect(mocks.toastError).toHaveBeenCalledTimes(1)
    expect(mocks.toastError.mock.calls[0]?.[1]?.description).toContain('Resume exited with code 3.')
    expect(mocks.setEphemeralVmWorkspaceWaking).toHaveBeenLastCalledWith('wt-vm', false)
  })
})
