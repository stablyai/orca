// @vitest-environment happy-dom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PublicKnownRuntimeEnvironment } from '../../../../shared/runtime-environments'
import { useManagedOrcadServers } from './use-managed-orcad-servers'

vi.mock('sonner', () => ({ toast: { success: vi.fn() } }))

const managedEnvironment = {
  id: 'managed-1',
  name: 'Managed host',
  orcadDeployment: {
    sshTargetId: 'ssh-1',
    sshTargetGeneration: 7,
    localPort: 46_768,
    remotePort: 6_768
  }
} as unknown as PublicKnownRuntimeEnvironment
const pairedEnvironment = {
  id: 'paired-1',
  name: 'Paired host'
} as PublicKnownRuntimeEnvironment

const list = vi.fn()
const listPendingOrcadMigrations = vi.fn()
const listPendingOrcadSshProvisioning = vi.fn()
const listTargets = vi.fn()
const getOrcadStatus = vi.fn()
const preflightOrcadTarget = vi.fn()
const deployOrcad = vi.fn()
const updateOrcad = vi.fn()
const rollbackOrcad = vi.fn()
const recoverOrcad = vi.fn()
const stopOrcad = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  list.mockResolvedValue([managedEnvironment, pairedEnvironment])
  listPendingOrcadMigrations.mockResolvedValue([])
  listPendingOrcadSshProvisioning.mockResolvedValue([])
  listTargets.mockResolvedValue([
    {
      id: 'ssh-available',
      label: 'Available host',
      host: 'example.com',
      port: 22,
      username: 'orca'
    }
  ])
  getOrcadStatus.mockResolvedValue({
    environmentId: 'managed-1',
    sshTargetId: 'ssh-1',
    activeVersion: '0.2.0+new',
    previousVersion: '0.1.0+old',
    activatedAt: new Date(1).toISOString(),
    rollbackAvailable: true,
    recovery: null
  })
  preflightOrcadTarget.mockResolvedValue({
    targetId: 'ssh-available',
    targetLabel: 'Available host',
    claimable: true,
    blockers: []
  })
  Object.assign(window, {
    api: {
      runtimeEnvironments: {
        list,
        listPendingOrcadMigrations,
        listPendingOrcadSshProvisioning,
        getOrcadStatus,
        preflightOrcadTarget,
        deployOrcad,
        updateOrcad,
        rollbackOrcad,
        recoverOrcad,
        stopOrcad
      },
      ssh: { listTargets }
    }
  })
})

afterEach(cleanup)

describe('useManagedOrcadServers', () => {
  it('loads managed environments, their status, and only main-owned available SSH targets', async () => {
    const view = renderHook(() => useManagedOrcadServers(vi.fn()))

    await waitFor(() => expect(view.result.current.loading).toBe(false))

    expect(view.result.current.environments.map((environment) => environment.id)).toEqual([
      'managed-1'
    ])
    expect(view.result.current.targets.map((target) => target.id)).toEqual(['ssh-available'])
    expect(view.result.current.statuses['managed-1']).toMatchObject({
      state: 'ready',
      status: { activeVersion: '0.2.0+new' }
    })
    expect(getOrcadStatus).toHaveBeenCalledWith({ selector: 'managed-1' })
  })

  it('loads and resumes a restart-visible migration without a registered environment', async () => {
    const pending = {
      environmentId: 'pending-1',
      name: 'Interrupted host',
      sshTargetId: 'ssh-pending',
      sshTargetLabel: 'Pending SSH host',
      phase: 'source-fenced' as const,
      startedAt: new Date(1).toISOString()
    }
    listPendingOrcadMigrations.mockResolvedValue([pending])
    deployOrcad.mockResolvedValue({
      outcome: 'already-current',
      activeVersion: '0.2.0+new',
      environment: managedEnvironment
    })
    const view = renderHook(() => useManagedOrcadServers(vi.fn()))
    await waitFor(() => expect(view.result.current.loading).toBe(false))

    expect(view.result.current.pendingMigrations).toEqual([pending])
    await act(async () => {
      await view.result.current.resumeMigration(pending)
    })

    expect(deployOrcad).toHaveBeenCalledWith({
      name: 'Interrupted host',
      sshTargetId: 'ssh-pending',
      force: undefined
    })
  })

  it('surfaces a deferred update as an actionable force confirmation', async () => {
    updateOrcad.mockResolvedValue({
      outcome: 'deferred',
      candidateVersion: '0.3.0+candidate',
      code: 'orcad_update_terminals_running',
      reason: 'Two terminals are live.',
      forceable: true
    })
    const view = renderHook(() => useManagedOrcadServers(vi.fn()))
    await waitFor(() => expect(view.result.current.loading).toBe(false))

    await act(async () => {
      await view.result.current.update('managed-1')
    })

    expect(view.result.current.forceOperation).toEqual({
      kind: 'update',
      environmentId: 'managed-1',
      candidateVersion: '0.3.0+candidate',
      reason: 'Two terminals are live.'
    })
  })

  it('fences an explicit migration preflight to the selected SSH target', async () => {
    const view = renderHook(() => useManagedOrcadServers(vi.fn()))
    await waitFor(() => expect(view.result.current.loading).toBe(false))

    act(() => view.result.current.selectSshTarget('ssh-available'))
    await waitFor(() => expect(view.result.current.targetPreflight?.state).toBe('ready'))

    expect(preflightOrcadTarget).toHaveBeenCalledWith({ sshTargetId: 'ssh-available' })
    expect(view.result.current.targetPreflight).toMatchObject({
      state: 'ready',
      targetId: 'ssh-available',
      preflight: { claimable: true }
    })
  })

  it('does not let an older target preflight overwrite a newer selection', async () => {
    let resolveFirst: ((value: unknown) => void) | undefined
    preflightOrcadTarget
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve
          })
      )
      .mockResolvedValueOnce({
        targetId: 'ssh-second',
        targetLabel: 'Second host',
        claimable: true,
        blockers: []
      })
    const view = renderHook(() => useManagedOrcadServers(vi.fn()))
    await waitFor(() => expect(view.result.current.loading).toBe(false))

    act(() => {
      view.result.current.selectSshTarget('ssh-available')
      view.result.current.selectSshTarget('ssh-second')
    })
    await waitFor(() =>
      expect(view.result.current.targetPreflight).toMatchObject({
        state: 'ready',
        targetId: 'ssh-second'
      })
    )
    await act(async () => {
      resolveFirst?.({
        targetId: 'ssh-available',
        targetLabel: 'Available host',
        claimable: false,
        blockers: [{ code: 'orcad_migration_target_owned', category: 'exclusive-ownership' }]
      })
      await Promise.resolve()
    })

    expect(view.result.current.targetPreflight).toMatchObject({
      state: 'ready',
      targetId: 'ssh-second'
    })
  })

  it('shows a non-forceable deployment refusal inline without offering force', async () => {
    deployOrcad.mockResolvedValue({
      outcome: 'deferred',
      candidateVersion: '0.3.0+candidate',
      code: 'orcad_initial_runtime_live',
      reason: 'An unmanaged runtime still owns this data root.',
      forceable: false
    })
    const view = renderHook(() => useManagedOrcadServers(vi.fn()))
    await waitFor(() => expect(view.result.current.loading).toBe(false))

    await act(async () => {
      await view.result.current.deploy({ name: 'Server', sshTargetId: 'ssh-available' })
    })

    expect(view.result.current.createError).toBe('An unmanaged runtime still owns this data root.')
    expect(view.result.current.forceOperation).toBeNull()
  })

  it('keeps a refused stop linked and exposes the host-owned verdict reason inline', async () => {
    stopOrcad.mockResolvedValue({
      outcome: 'refused',
      verdict: 'unverifiable',
      code: 'orcad_stop_terminal_census_unverifiable',
      reason: 'Terminal liveness is unverifiable.'
    })
    const changed = vi.fn()
    const view = renderHook(() => useManagedOrcadServers(changed))
    await waitFor(() => expect(view.result.current.loading).toBe(false))

    await act(async () => {
      await view.result.current.stopAndUnlink('managed-1')
    })

    expect(view.result.current.rowErrors['managed-1']).toBe('Terminal liveness is unverifiable.')
    expect(changed).not.toHaveBeenCalled()
  })

  it.each(['refused', 'transport-error'])(
    'reloads prepared stop recovery after %s',
    async (outcome) => {
      const reason = 'Stop was not confirmed.'
      const changed = vi.fn()
      const view = renderHook(() => useManagedOrcadServers(changed))
      await waitFor(() => expect(view.result.current.loading).toBe(false))
      const recovery = { operation: 'decommission', phase: 'prepared' }
      getOrcadStatus.mockResolvedValue({ environmentId: 'managed-1', recovery })
      if (outcome === 'refused') {
        stopOrcad.mockResolvedValue({ outcome, reason })
      } else {
        stopOrcad.mockRejectedValue(new Error(reason))
      }

      await act(async () => {
        await view.result.current.stopAndUnlink('managed-1')
      })

      expect(getOrcadStatus).toHaveBeenCalledTimes(2)
      expect(view.result.current.statuses['managed-1']).toMatchObject({
        state: 'ready',
        status: { recovery }
      })
      expect(view.result.current.rowErrors['managed-1']).toBe(reason)
      expect(view.result.current.environments).toEqual([managedEnvironment])
      expect(view.result.current.busyAction).toBeNull()
      expect(changed).not.toHaveBeenCalled()
    }
  )

  it.each(['refused', 'transport-error'])(
    'preserves the %s reason when recovery refresh fails',
    async (outcome) => {
      const reason = 'Stop was not confirmed.'
      const view = renderHook(() => useManagedOrcadServers(vi.fn()))
      await waitFor(() => expect(view.result.current.loading).toBe(false))
      list.mockRejectedValueOnce(new Error('Catalog unavailable.'))
      if (outcome === 'refused') {
        stopOrcad.mockResolvedValue({ outcome, reason })
      } else {
        stopOrcad.mockRejectedValue(new Error(reason))
      }

      await act(async () => {
        await view.result.current.stopAndUnlink('managed-1')
      })

      expect(view.result.current.rowErrors['managed-1']).toBe(reason)
      expect(view.result.current.loadError).toBe('Catalog unavailable.')
      expect(view.result.current.environments).toEqual([managedEnvironment])
      expect(view.result.current.busyAction).toBeNull()
      expect(view.result.current.loading).toBe(false)
    }
  )

  it('keeps a fresh interrupted activation visible until its fence is recoverable', async () => {
    recoverOrcad.mockResolvedValue({
      outcome: 'pending',
      code: 'orcad_recovery_transaction_still_fresh',
      reason: 'Retry after the recovery window.'
    })
    const view = renderHook(() => useManagedOrcadServers(vi.fn()))
    await waitFor(() => expect(view.result.current.loading).toBe(false))

    await act(async () => {
      await view.result.current.recover('managed-1')
    })

    expect(recoverOrcad).toHaveBeenCalledWith({ selector: 'managed-1' })
    expect(view.result.current.rowErrors['managed-1']).toBe('Retry after the recovery window.')
  })
})
