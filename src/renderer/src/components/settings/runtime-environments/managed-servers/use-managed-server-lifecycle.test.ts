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

function managedStatus(version: 'old' | 'new', deferred: boolean): OrcadManagedRuntimeStatus {
  return {
    environmentId: 'env-test',
    sshTargetId: 'ssh-test',
    activeVersion: version === 'old' ? '1.2.0+old' : '1.3.0+new',
    activeAppVersion: version === 'old' ? '1.2.0' : '1.3.0',
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
const DEFERRED = managedStatus('old', true)
const UPDATED = managedStatus('new', false)

type PendingRead = {
  resolve: (status: OrcadManagedRuntimeStatus) => void
  reject: (error: Error) => void
}

/** getStatus calls held until a test settles them, so their order is explicit. */
function setup() {
  const reads: PendingRead[] = []
  const getStatus = vi.fn(
    () =>
      new Promise<OrcadManagedRuntimeStatus>((resolve, reject) => {
        reads.push({ resolve, reject })
      })
  )
  let finishUpdate: () => void = () => {}
  const update = vi.fn(
    () =>
      new Promise((resolve) => {
        finishUpdate = () => resolve({ outcome: 'updated' })
      })
  )
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hook calls only getStatus and update here.
  const api = { getStatus, update } as unknown as ManagedOrcadPreloadApi
  const hook = renderHook(() =>
    useManagedServerLifecycle({ api, environment: { id: 'env-test' }, onChanged: () => {} })
  )
  const settle = async (index: number, result: OrcadManagedRuntimeStatus | Error) => {
    await act(async () => {
      if (result instanceof Error) {
        reads[index].reject(result)
      } else {
        reads[index].resolve(result)
      }
      await Promise.resolve()
    })
  }
  const rerenderWith = async (runtimeId: string | null) => {
    mocks.runtimeId = runtimeId
    await act(async () => {
      hook.rerender()
      await Promise.resolve()
    })
  }
  return { hook, getStatus, reads, settle, rerenderWith, finishUpdate: () => finishUpdate() }
}

describe('useManagedServerLifecycle status reads', () => {
  beforeEach(() => {
    mocks.runtimeId = 'runtime-old'
  })
  afterEach(() => {
    cleanup()
  })

  describe('stale reads (RS-01)', () => {
    it('keeps the newer status when an older read succeeds late', async () => {
      const { hook, reads, settle } = setup()
      await act(async () => {
        void hook.result.current.loadStatus()
      })
      expect(reads).toHaveLength(2)
      await settle(1, UPDATED)
      await settle(0, DEFERRED)
      expect(hook.result.current.status).toBe(UPDATED)
      expect(hook.result.current.busy).toBeNull()
    })

    it('keeps the newer status when an older read fails late', async () => {
      const { hook, reads, settle } = setup()
      await act(async () => {
        void hook.result.current.loadStatus()
      })
      expect(reads).toHaveLength(2)
      await settle(1, UPDATED)
      await settle(0, new Error('ssh: connection reset'))
      expect(hook.result.current.status).toBe(UPDATED)
      expect(hook.result.current.statusError).toBeNull()
    })

    it('stays loading until the newest read settles', async () => {
      const { hook, reads, settle } = setup()
      await act(async () => {
        void hook.result.current.loadStatus()
      })
      expect(reads).toHaveLength(2)
      await settle(0, DEFERRED)
      expect(hook.result.current.busy).toBe('status')
      expect(hook.result.current.status).toBeNull()
      await settle(1, UPDATED)
      expect(hook.result.current.busy).toBeNull()
    })

    it('keeps an action busy when a status read settles during it', async () => {
      const { hook, reads, settle, finishUpdate } = setup()
      await settle(0, DEFERRED)
      let running: Promise<void> = Promise.resolve()
      act(() => {
        running = hook.result.current.run('update')
      })
      await act(async () => {
        void hook.result.current.loadStatus()
      })
      await settle(1, DEFERRED)
      expect(hook.result.current.busy).toBe('update')

      await act(async () => {
        finishUpdate()
        await running
      })
      // The action's own follow-up read.
      expect(reads).toHaveLength(3)
      await settle(2, UPDATED)
      expect(hook.result.current.busy).toBeNull()
      expect(hook.result.current.status).toBe(UPDATED)
    })
  })

  describe('runtime coverage (RS-02)', () => {
    it('reads again on first contact when the mount read ran before it', async () => {
      mocks.runtimeId = null
      const { hook, reads, settle, rerenderWith } = setup()
      await settle(0, DEFERRED)
      expect(hook.result.current.status?.deferredUpdate).not.toBeNull()
      await rerenderWith('runtime-new')
      expect(reads).toHaveLength(2)
      await settle(1, UPDATED)
      expect(hook.result.current.status?.deferredUpdate).toBeNull()
    })

    it('reads again when a server returns as a new runtime after a gap', async () => {
      const { hook, reads, settle, rerenderWith } = setup()
      await settle(0, DEFERRED)
      await rerenderWith(null)
      expect(reads).toHaveLength(1)
      await rerenderWith('runtime-new')
      expect(reads).toHaveLength(2)
      await settle(1, UPDATED)
      expect(hook.result.current.status).toBe(UPDATED)
    })

    it('does not read again for the same runtime, even after a gap', async () => {
      const { reads, settle, rerenderWith } = setup()
      await settle(0, DEFERRED)
      await rerenderWith('runtime-old')
      await rerenderWith(null)
      await rerenderWith('runtime-old')
      expect(reads).toHaveLength(1)
    })

    it('does not repeat a read already started under the new runtime', async () => {
      const { hook, reads, settle, rerenderWith, finishUpdate } = setup()
      await settle(0, DEFERRED)
      let running: Promise<void> = Promise.resolve()
      act(() => {
        running = hook.result.current.run('update')
      })
      // The server restarts during the Update: the action reads when it ends.
      await rerenderWith('runtime-new')
      expect(reads).toHaveLength(1)
      expect(hook.result.current.busy).toBe('update')
      await act(async () => {
        finishUpdate()
        await running
      })
      expect(reads).toHaveLength(2)
      await rerenderWith('runtime-new')
      expect(reads).toHaveLength(2)
      await settle(1, UPDATED)
      expect(hook.result.current.status?.deferredUpdate).toBeNull()
    })

    it('reads again when the runtime changes after the follow-up read started', async () => {
      const { hook, reads, settle, rerenderWith, finishUpdate } = setup()
      await settle(0, DEFERRED)
      let running: Promise<void> = Promise.resolve()
      act(() => {
        running = hook.result.current.run('update')
      })
      await act(async () => {
        finishUpdate()
        await running
      })
      expect(reads).toHaveLength(2)
      // Freshness of the follow-up read is not established for a runtime seen after it began.
      await rerenderWith('runtime-new')
      expect(reads).toHaveLength(3)
      await settle(2, UPDATED)
      await settle(1, DEFERRED)
      expect(hook.result.current.status).toBe(UPDATED)
    })
  })
})
