// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrcadManagedRuntimeStatus } from '../../../../../../shared/remote-runtime/orcad-lifecycle/orcad-managed-runtime'
import { UNVERIFIABLE_ORCAD_TERMINAL_CENSUS } from '../../../../../../shared/remote-runtime/orcad-lifecycle/orcad-terminal-census'
import type { ManagedOrcadPreloadApi } from '../../../../../../preload/api/runtime/managed-orcad-api'
import { useManagedServerLifecycle } from './use-managed-server-lifecycle'

const mocks = vi.hoisted(() => {
  const state: { runtimeId: string | null } = { runtimeId: null }
  return state
})

// The hook reads the last verified runtime ID; the row tests cover how status entries map to it.
vi.mock('@/store/slices/runtime-status/views/use-runtime-status-view', () => ({
  useRuntimeHostStatusSelector: () => mocks.runtimeId
}))
vi.mock('sonner', () => ({ toast: { message: vi.fn(), error: vi.fn() } }))

function managedStatus(deferred: boolean): OrcadManagedRuntimeStatus {
  return {
    environmentId: 'env-test',
    sshTargetId: 'ssh-test',
    activeVersion: deferred ? '1.2.0+old' : '1.3.0+new',
    activeAppVersion: deferred ? '1.2.0' : '1.3.0',
    previousVersion: null,
    activatedAt: null,
    rollbackAvailable: false,
    recovery: null,
    terminals: UNVERIFIABLE_ORCAD_TERMINAL_CENSUS,
    migration: null,
    deferredUpdate: deferred
      ? {
          outcome: 'deferred',
          candidateVersion: '1.3.0+new',
          code: 'orcad_update_terminals_running',
          reason: 'Terminals are running',
          deferredAt: '2026-01-01T00:00:00Z'
        }
      : null
  }
}

function setup() {
  let deferred = true
  let finishUpdate: () => void = () => {}
  const getStatus = vi.fn(async () => managedStatus(deferred))
  const update = vi.fn(
    () =>
      new Promise((resolve) => {
        finishUpdate = () => resolve({ outcome: 'updated' })
      })
  )
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hook calls only getStatus and update here.
  const api = { getStatus, update } as unknown as ManagedOrcadPreloadApi
  const hook = renderHook(() =>
    useManagedServerLifecycle({
      api,
      environment: { id: 'env-test' },
      onChanged: () => {}
    })
  )
  return {
    hook,
    getStatus,
    landUpdate: () => {
      deferred = false
    },
    finishUpdate: () => finishUpdate()
  }
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
  })
}

describe('useManagedServerLifecycle runtime restarts', () => {
  beforeEach(() => {
    mocks.runtimeId = 'runtime-old'
  })
  afterEach(() => {
    cleanup()
  })

  it('reloads status when the server comes back as a new runtime, dropping a stale deferral', async () => {
    const { hook, getStatus, landUpdate } = setup()
    await settle()
    expect(getStatus).toHaveBeenCalledTimes(1)
    expect(hook.result.current.status?.deferredUpdate).not.toBeNull()

    landUpdate()
    mocks.runtimeId = 'runtime-new'
    hook.rerender()
    await settle()
    expect(getStatus).toHaveBeenCalledTimes(2)
    expect(hook.result.current.status?.deferredUpdate).toBeNull()
    expect(hook.result.current.status?.activeAppVersion).toBe('1.3.0')
  })

  it('does not reload on first contact or for the same runtime', async () => {
    mocks.runtimeId = null
    const { hook, getStatus } = setup()
    await settle()
    mocks.runtimeId = 'runtime-old'
    hook.rerender()
    await settle()
    hook.rerender()
    await settle()
    expect(getStatus).toHaveBeenCalledTimes(1)
  })

  it('leaves the reload to an Update that restarted the server itself', async () => {
    const { hook, getStatus, landUpdate, finishUpdate } = setup()
    await settle()
    let running: Promise<void> = Promise.resolve()
    act(() => {
      running = hook.result.current.run('update')
    })
    landUpdate()
    mocks.runtimeId = 'runtime-new'
    hook.rerender()
    await settle()
    // A reload now would clear the Update's busy state while it is still running.
    expect(getStatus).toHaveBeenCalledTimes(1)
    expect(hook.result.current.busy).toBe('update')

    await act(async () => {
      finishUpdate()
      await running
    })
    await settle()
    expect(getStatus).toHaveBeenCalledTimes(2)
    expect(hook.result.current.status?.deferredUpdate).toBeNull()
  })
})
