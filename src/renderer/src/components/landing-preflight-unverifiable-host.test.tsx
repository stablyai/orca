// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeHostStatusSnapshot } from '../../../shared/runtime-host-status'
import { useAppStore } from '../store'
import type { AppState } from '../store/types'
import { useLandingPreflightRuntime } from './landing-preflight-runtime'

const ENVIRONMENT_ID = 'environment-a'
const initialState = useAppStore.getInitialState()
const invalidate = vi.fn()
const refresh = vi.fn(async () => {})

function snapshot(overrides: Partial<RuntimeHostStatusSnapshot> = {}): RuntimeHostStatusSnapshot {
  return {
    environmentId: ENVIRONMENT_ID,
    pairingRevision: 1,
    sequence: 1,
    checkedAt: 1,
    status: { runtimeId: 'runtime-a' } as RuntimeHostStatusSnapshot['status'],
    verification: 'verified',
    transport: 'ready',
    ...overrides
  }
}

function setStatusEntry(entry: unknown): void {
  useAppStore.setState({
    runtimeStatusByEnvironmentId: new Map([
      [ENVIRONMENT_ID, entry]
    ]) as AppState['runtimeStatusByEnvironmentId']
  })
}

describe('landing preflight under an unverifiable host probe', () => {
  beforeEach(() => {
    invalidate.mockClear()
    refresh.mockClear()
    useAppStore.setState(
      {
        ...initialState,
        settings: { activeRuntimeEnvironmentId: ENVIRONMENT_ID } as AppState['settings'],
        invalidatePreflightStatus: invalidate,
        refreshPreflightStatus: refresh
      },
      true
    )
    setStatusEntry({ status: { runtimeId: 'runtime-a' }, snapshot: snapshot(), checkedAt: 1 })
  })

  afterEach(() => {
    cleanup()
    useAppStore.setState(initialState, true)
  })

  it('keeps preflight state when a ready host answers an unverifiable probe', () => {
    renderHook(() => useLandingPreflightRuntime())
    expect(invalidate).not.toHaveBeenCalled()

    act(() => {
      setStatusEntry({
        status: null,
        snapshot: snapshot({ sequence: 2, checkedAt: 2, verification: 'unavailable' }),
        checkedAt: 2
      })
    })

    expect(invalidate).not.toHaveBeenCalled()
  })

  it('still discards preflight state once the transport goes down', () => {
    renderHook(() => useLandingPreflightRuntime())

    act(() => {
      setStatusEntry({
        status: null,
        snapshot: snapshot({
          sequence: 2,
          checkedAt: 2,
          verification: 'unavailable',
          transport: 'disconnected'
        }),
        checkedAt: 2
      })
    })

    expect(invalidate).toHaveBeenCalled()
  })
})
