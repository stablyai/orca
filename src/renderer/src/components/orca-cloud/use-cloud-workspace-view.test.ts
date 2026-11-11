// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { seedCloudWorkspaceSnapshot } from '@/lib/orca-cloud/orca-cloud-workspace-store'
import type { HostedWorkspaceStatus } from '../../../../shared/hosted-sandbox/hosted-sandbox-wire'
import { useCloudWorkspaceView } from './use-cloud-workspace-view'

vi.mock('@/components/sidebar/workspace-actions/sleep/use-worktree-sleep-state', () => ({
  useIsSleepingWorktree: () => false
}))

const T0 = 1_800_000_000_000
const ready: HostedWorkspaceStatus = {
  state: 'ready',
  metrics: null,
  uptimeMs: null,
  usage: { totalMs: 0, centsPerHour: 100, costCents: 0 },
  archive: null,
  checkedAt: T0
}

afterEach(() => {
  cleanup()
  seedCloudWorkspaceSnapshot({})
  useAppStore.setState({ ephemeralVmRuntimesByWorkspaceId: {} })
})

describe('cloud workspace state right after Sleep (RA-13)', () => {
  it('reads asleep from the local VM record while the last status read still says ready', () => {
    act(() => {
      seedCloudWorkspaceSnapshot({
        ids: new Set(['ws']),
        idsLoaded: true,
        status: { ws: { status: ready, loading: false, error: null, fetchedAt: T0 } }
      })
      useAppStore.setState({
        ephemeralVmRuntimesByWorkspaceId: {
          ws: { id: 'vm', workspaceId: 'ws', status: 'suspended', canSuspend: true }
        }
      })
    })
    const { result } = renderHook(() => useCloudWorkspaceView('ws'))
    expect(result.current.state).toBe('sleeping')
  })

  it('stays running when the VM record is running too', () => {
    act(() => {
      seedCloudWorkspaceSnapshot({
        ids: new Set(['ws']),
        idsLoaded: true,
        status: { ws: { status: ready, loading: false, error: null, fetchedAt: T0 } }
      })
      useAppStore.setState({
        ephemeralVmRuntimesByWorkspaceId: {
          ws: { id: 'vm', workspaceId: 'ws', status: 'running', canSuspend: true }
        }
      })
    })
    const { result } = renderHook(() => useCloudWorkspaceView('ws'))
    expect(result.current.state).toBe('running')
  })
})
