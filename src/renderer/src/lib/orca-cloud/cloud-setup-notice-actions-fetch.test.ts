import { afterEach, describe, expect, it, vi } from 'vitest'

const { repoAccess, runCheck, toastSuccess, refreshGitAccess } = vi.hoisted(() => ({
  repoAccess: vi.fn(),
  runCheck: vi.fn(),
  toastSuccess: vi.fn(),
  refreshGitAccess: vi.fn(async () => ({ ok: true, value: { applied: true } }))
}))
vi.mock('./use-orca-cloud-repo-access', () => ({
  fetchOrcaCloudRepoAccess: repoAccess,
  invalidateOrcaCloudRepoAccess: vi.fn()
}))
vi.mock('@/runtime/ephemeral-vm/ephemeral-vm-environment-check', () => ({
  runVmEnvironmentCheck: runCheck
}))
vi.mock('@/runtime/repo-hooks/runtime-hooks-client', () => ({ checkRuntimeHooks: vi.fn() }))
vi.mock('@/store', () => ({ useAppStore: { getState: () => ({}) } }))
vi.mock('./orca-cloud-workspace-store', () => ({ cloudWorkspaceApi: () => ({ refreshGitAccess }) }))
vi.mock('sonner', () => ({ toast: { success: toastSuccess, error: vi.fn() } }))

import { recheckCloudPushAccess } from './cloud-setup-notice-actions'
import {
  getCloudSetupNoticesRecord,
  resetCloudSetupNotices,
  setCloudSetupNotices
} from './cloud-setup-notices-store'

const FETCH = {
  id: 'git.fetch',
  kind: 'fetch' as const,
  check: { id: 'git.fetch', category: 'git' as const, status: 'fail' as const, message: 'x' }
}

function seed(): void {
  setCloudSetupNotices({
    environmentId: 'env-1',
    path: '/w',
    repoId: 'r',
    hostId: null,
    repoUrl: 'https://github.com/stablyai/orca-plugins',
    notices: [FETCH]
  })
}

afterEach(() => {
  resetCloudSetupNotices()
  vi.clearAllMocks()
})

describe('recheckCloudPushAccess covers the can’t-reach line too (GH-FETCH-REASON)', () => {
  it('waits while GitHub has not confirmed the install', async () => {
    seed()
    repoAccess.mockResolvedValue({ access: 'missing' })
    expect(await recheckCloudPushAccess('env-1')).toBe('waiting')
    expect(runCheck).not.toHaveBeenCalled()
  })

  it('drops the line once origin answers', async () => {
    seed()
    repoAccess.mockResolvedValue({ access: 'granted' })
    runCheck.mockResolvedValue({ checks: [{ ...FETCH.check, status: 'pass' }] })
    expect(await recheckCloudPushAccess('env-1')).toBe('granted')
    expect(getCloudSetupNoticesRecord('env-1')?.notices ?? []).toEqual([])
    expect(toastSuccess).toHaveBeenCalledWith('This workspace can reach stablyai/orca-plugins now.')
  })

  it('keeps it (refused) when the install landed but this workspace still can’t reach origin', async () => {
    seed()
    repoAccess.mockResolvedValue({ access: 'granted' })
    runCheck.mockResolvedValue({ checks: [FETCH.check] })
    expect(await recheckCloudPushAccess('env-1')).toBe('refused')
    expect(getCloudSetupNoticesRecord('env-1')?.notices).toHaveLength(1)
  })
})

describe('LIVE-GIT-ACCESS: Check again applies the new access to the running workspace first', () => {
  it('asks for the live refresh, then re-runs the check', async () => {
    seed()
    repoAccess.mockResolvedValue({ access: 'granted' })
    const order: string[] = []
    refreshGitAccess.mockImplementationOnce(
      async () => (order.push('refresh'), { ok: true, value: { applied: true } })
    )
    runCheck.mockImplementationOnce(
      async () => (order.push('check'), { checks: [{ ...FETCH.check, status: 'pass' }] })
    )
    expect(await recheckCloudPushAccess('env-1', { workspaceId: 'w1' })).toBe('granted')
    expect(refreshGitAccess).toHaveBeenCalledWith({ workspaceId: 'w1' })
    expect(order).toEqual(['refresh', 'check'])
  })

  it('never asks while GitHub has not confirmed the install', async () => {
    seed()
    repoAccess.mockResolvedValue({ access: 'missing' })
    await recheckCloudPushAccess('env-1', { workspaceId: 'w1' })
    expect(refreshGitAccess).not.toHaveBeenCalled()
  })
})
