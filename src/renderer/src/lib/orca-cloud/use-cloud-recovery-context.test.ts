// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import type { HostedWorkspaceStatus } from '../../../../shared/hosted-sandbox/hosted-sandbox-wire'
import { seedCloudWorkspaceSnapshot } from './orca-cloud-workspace-store'
import { useCloudRecoveryContext } from './use-cloud-recovery-context'

const T0 = 1_800_000_000_000

const status = (state: HostedWorkspaceStatus['state']): HostedWorkspaceStatus => ({
  state,
  metrics: null,
  uptimeMs: null,
  usage: { totalMs: 0, centsPerHour: 100, costCents: 0 },
  archive: null,
  checkedAt: T0
})

function seed(state: HostedWorkspaceStatus['state'] | null): void {
  seedCloudWorkspaceSnapshot({
    ids: new Set(['ws']),
    idsLoaded: true,
    status: state
      ? { ws: { status: status(state), loading: false, error: null, fetchedAt: T0 } }
      : {}
  })
}

afterEach(() => {
  cleanup()
  seedCloudWorkspaceSnapshot({})
  useAppStore.setState({ ephemeralVmRuntimesByWorkspaceId: {} })
})

describe('terminal recovery for an asleep Orca Cloud workspace (RA-12)', () => {
  it('is asleep when the control plane says so, so no "Reconnecting… Down for" toast', () => {
    act(() => seed('sleeping'))
    const { result } = renderHook(() => useCloudRecoveryContext('ws'))
    expect(result.current).toMatchObject({ asleep: true, waking: false })
  })

  it('is asleep right after Sleep from this computer, before the status poll catches up', () => {
    act(() => {
      seed('ready')
      useAppStore.setState({
        ephemeralVmRuntimesByWorkspaceId: {
          ws: { id: 'vm', workspaceId: 'ws', status: 'suspended', canSuspend: true }
        }
      })
    })
    const { result } = renderHook(() => useCloudRecoveryContext('ws'))
    expect(result.current?.asleep).toBe(true)
  })

  it('a running workspace whose connection dropped still reconnects', () => {
    act(() => seed('ready'))
    const { result } = renderHook(() => useCloudRecoveryContext('ws'))
    expect(result.current?.asleep).toBe(false)
  })

  it('is not a cloud workspace: no context at all', () => {
    act(() => seed('sleeping'))
    const { result } = renderHook(() => useCloudRecoveryContext('local'))
    expect(result.current).toBeNull()
  })
})
