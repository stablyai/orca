// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorktreeHostConnection } from '@/lib/worktree-host-connection-phase'

const mocks = vi.hoisted(() => {
  const hostConnection: WorktreeHostConnection = {
    phase: 'connecting',
    targetId: 'target-a',
    connectionGeneration: null
  }
  return { hostConnection, prepare: vi.fn() }
})

vi.mock('@/lib/worktree-runtime-owner', () => ({
  getExecutionHostIdForWorktree: () => 'ssh:target-a'
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

function setHost(
  phase: WorktreeHostConnection['phase'],
  connectionGeneration: number | null = null
): void {
  mocks.hostConnection = { phase, targetId: 'target-a', connectionGeneration }
}

describe('useSshWorkspaceBrowserRoute under a reconnecting SSH host', () => {
  beforeEach(() => {
    mocks.prepare.mockReset()
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
    // Why: the card must say it is connecting, not show the failure, while the host dials.
    expect(result.current.state).toEqual({ kind: 'preparing' })
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
})
