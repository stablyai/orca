// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorktreeHostConnection } from '@/lib/worktree-host-connection-phase'
import type { SshConnectionStatus } from '../../../../shared/ssh-types'

const mocks = vi.hoisted(() => {
  const hostConnection: WorktreeHostConnection = {
    phase: 'connecting',
    targetId: 'target-a',
    environmentId: null,
    publishedStatus: 'connecting',
    connectedEpoch: null
  }
  const route: { executionHostId: string | null } = { executionHostId: 'ssh:target-a' }
  return { hostConnection, ...route, prepare: vi.fn() }
})

vi.mock('@/lib/worktree-runtime-owner', () => ({
  getExecutionHostIdForWorktree: () => mocks.executionHostId
}))
vi.mock('@/lib/worktree-host-connection-phase', () => ({
  selectWorktreeHostConnectionPhase: () => mocks.hostConnection,
  useWorktreeHostConnection: () => mocks.hostConnection
}))

import { useSshWorkspaceBrowserRoute } from './use-ssh-workspace-browser-route'

const READY_PARTITION = 'persist:orca-browser-v1-routed'

const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })

const STATUS_BY_PHASE: Record<WorktreeHostConnection['phase'], SshConnectionStatus | null> = {
  local: null,
  connecting: 'connecting',
  connected: 'connected',
  unavailable: 'disconnected',
  unverifiable: null
}

function setHost(
  phase: WorktreeHostConnection['phase'],
  connectionGeneration: number | null = null
): void {
  mocks.hostConnection = {
    phase,
    targetId: 'target-a',
    environmentId: null,
    publishedStatus: STATUS_BY_PHASE[phase],
    connectedEpoch: phase === 'connected' ? `target-a:${connectionGeneration}` : null
  }
}

describe('useSshWorkspaceBrowserRoute under a reconnecting SSH host', () => {
  beforeEach(() => {
    mocks.prepare.mockReset()
    mocks.executionHostId = 'ssh:target-a'
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { browser: { prepareSshWorkspacePartition: mocks.prepare } }
    })
  })
  afterEach(() => cleanup())

  it('waits while the host connects, then prepares exactly once when it connects', async () => {
    setHost('connecting')
    mocks.prepare.mockResolvedValue({ partition: READY_PARTITION })
    const { result, rerender } = renderHook(() => useSshWorkspaceBrowserRoute('wt-1', null))
    await settle()
    expect(result.current.state).toEqual({ kind: 'preparing' })
    expect(mocks.prepare).not.toHaveBeenCalled()

    setHost('connected', 1)
    rerender()
    await settle()
    expect(mocks.prepare).toHaveBeenCalledOnce()
    expect(result.current.state).toEqual({
      kind: 'ready',
      partition: READY_PARTITION,
      targetId: 'target-a'
    })
  })

  it('re-derives an ssh-unavailable error without Retry once the host connects', async () => {
    setHost('unavailable')
    mocks.prepare.mockRejectedValueOnce(new Error('browser_local_route_ssh_unavailable'))
    mocks.prepare.mockResolvedValueOnce({ partition: READY_PARTITION })
    const { result, rerender } = renderHook(() => useSshWorkspaceBrowserRoute('wt-1', null))
    await settle()
    expect(result.current.state.kind).toBe('error')

    setHost('connecting')
    rerender()
    await settle()
    // Why: a dial is a transient; the classified card stays until the host actually connects.
    expect(result.current.state.kind).toBe('error')
    expect(mocks.prepare).toHaveBeenCalledOnce()

    setHost('connected', 1)
    rerender()
    await settle()
    expect(mocks.prepare).toHaveBeenCalledTimes(2)
    expect(result.current.state.kind).toBe('ready')
  })

  it('re-prepares a failed route when the host reconnects under a new generation', async () => {
    setHost('connected', 1)
    mocks.prepare.mockRejectedValueOnce(new Error('browser_local_route_ssh_unavailable'))
    mocks.prepare.mockResolvedValueOnce({ partition: READY_PARTITION })
    const { result, rerender } = renderHook(() => useSshWorkspaceBrowserRoute('wt-1', null))
    await settle()
    expect(result.current.state.kind).toBe('error')

    setHost('connected', 2)
    rerender()
    await settle()
    expect(mocks.prepare).toHaveBeenCalledTimes(2)
    expect(result.current.state.kind).toBe('ready')
  })

  it('prepares once while connected and keeps a ready page mounted across a reconnect', async () => {
    setHost('connected', 1)
    mocks.prepare.mockResolvedValue({ partition: READY_PARTITION })
    const { result, rerender } = renderHook(() => useSshWorkspaceBrowserRoute('wt-1', null))
    await settle()
    rerender()
    rerender()
    await settle()
    expect(mocks.prepare).toHaveBeenCalledOnce()

    setHost('connecting', 1)
    rerender()
    await settle()
    expect(result.current.state.kind).toBe('ready')

    setHost('connected', 2)
    rerender()
    await settle()
    expect(mocks.prepare).toHaveBeenCalledOnce()
    expect(result.current.state.kind).toBe('ready')
  })

  it('keeps a failed route on its card while another pane redials the host, then recovers on connect', async () => {
    // The e2e sequence: the user disconnects, a browser tab classifies the dead host, and the
    // workspace's terminal redials it. Dial transients must not swap the card for "preparing".
    setHost('unavailable')
    mocks.prepare.mockRejectedValueOnce(new Error('browser_local_route_ssh_unavailable'))
    mocks.prepare.mockResolvedValueOnce({ partition: READY_PARTITION })
    const { result, rerender } = renderHook(() => useSshWorkspaceBrowserRoute('wt-1', null))
    await settle()
    const card = result.current.state
    expect(card).toMatchObject({ kind: 'error', errorKind: 'ssh-unavailable' })

    for (const phase of ['connecting', 'unavailable', 'connecting', 'unavailable'] as const) {
      setHost(phase)
      rerender()
      await settle()
      expect(result.current.state).toEqual(card)
    }
    expect(mocks.prepare).toHaveBeenCalledOnce()

    setHost('connected', 2)
    rerender()
    await settle()
    expect(mocks.prepare).toHaveBeenCalledTimes(2)
    expect(result.current.state.kind).toBe('ready')
  })

  it('waits for the connect when Retry is pressed while the host dials', async () => {
    setHost('unavailable')
    mocks.prepare.mockRejectedValueOnce(new Error('browser_local_route_ssh_unavailable'))
    mocks.prepare.mockResolvedValueOnce({ partition: READY_PARTITION })
    const { result, rerender } = renderHook(() => useSshWorkspaceBrowserRoute('wt-1', null))
    await settle()
    expect(result.current.state.kind).toBe('error')

    setHost('connecting')
    rerender()
    await settle()
    act(() => result.current.retry())
    await settle()
    expect(result.current.state).toEqual({ kind: 'preparing' })
    expect(mocks.prepare).toHaveBeenCalledOnce()

    setHost('connected', 1)
    rerender()
    await settle()
    expect(mocks.prepare).toHaveBeenCalledTimes(2)
    expect(result.current.state.kind).toBe('ready')
  })

  it('waits for a dialing host when the route becomes routed mid-dial', async () => {
    // Why: an unrouted route is not an answer for the target it just gained.
    mocks.executionHostId = null
    setHost('connecting')
    mocks.prepare.mockResolvedValue({ partition: READY_PARTITION })
    const { result, rerender } = renderHook(() => useSshWorkspaceBrowserRoute('wt-1', null))
    await settle()
    expect(result.current.state).toEqual({ kind: 'unrouted' })

    mocks.executionHostId = 'ssh:target-a'
    rerender()
    await settle()
    expect(result.current.state).toEqual({ kind: 'preparing' })
    expect(mocks.prepare).not.toHaveBeenCalled()

    setHost('connected', 1)
    rerender()
    await settle()
    expect(mocks.prepare).toHaveBeenCalledOnce()
    expect(result.current.state.kind).toBe('ready')
  })

  it('prepares normally for a host it cannot verify instead of waiting on it', async () => {
    setHost('unverifiable')
    mocks.prepare.mockResolvedValue({ partition: READY_PARTITION })
    const { result } = renderHook(() => useSshWorkspaceBrowserRoute('wt-1', null))
    await settle()
    expect(mocks.prepare).toHaveBeenCalledOnce()
    expect(result.current.state.kind).toBe('ready')
  })
})
