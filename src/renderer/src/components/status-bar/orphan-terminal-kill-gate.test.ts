// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { killMock, recordBreadcrumbMock } = vi.hoisted(() => ({
  killMock: vi.fn(() => Promise.resolve()),
  recordBreadcrumbMock: vi.fn()
}))

vi.mock('@/lib/crash-diagnostics', () => ({
  recordRendererCrashBreadcrumb: recordBreadcrumbMock
}))

import type { DaemonSession } from './resource-usage-merge-types'
import { useOrphanKillGate } from './orphan-terminal-kill-gate'

function makeSession(id: string): DaemonSession {
  return { id, cwd: '/repo', title: 'zsh' }
}

describe('useOrphanKillGate', () => {
  beforeEach(() => {
    killMock.mockClear()
    recordBreadcrumbMock.mockClear()
    ;(window as unknown as { api: { pty: { kill: typeof killMock } } }).api = {
      pty: { kill: killMock }
    }
  })

  it('stages orphans on request without killing anything', () => {
    const setSessions = vi.fn()
    const refreshSessions = vi.fn()
    const { result } = renderHook(() =>
      useOrphanKillGate({ setSessions, refreshSessions, getBoundPtyIds: () => new Set<string>() })
    )

    act(() => {
      result.current.request([makeSession('a'), makeSession('b')])
    })

    expect(result.current.pending).toHaveLength(2)
    expect(killMock).not.toHaveBeenCalled()
    expect(recordBreadcrumbMock).not.toHaveBeenCalled()
  })

  it('ignores an empty request', () => {
    const { result } = renderHook(() =>
      useOrphanKillGate({
        setSessions: vi.fn(),
        refreshSessions: vi.fn(),
        getBoundPtyIds: () => new Set<string>()
      })
    )

    act(() => {
      result.current.request([])
    })

    expect(result.current.pending).toBeNull()
  })

  it('kills staged orphans and records the mass-kill breadcrumb only on confirm', async () => {
    const setSessions = vi.fn()
    const refreshSessions = vi.fn()
    const { result } = renderHook(() =>
      useOrphanKillGate({ setSessions, refreshSessions, getBoundPtyIds: () => new Set<string>() })
    )

    act(() => {
      result.current.request([makeSession('a'), makeSession('b')])
    })
    expect(killMock).not.toHaveBeenCalled()

    await act(async () => {
      await result.current.confirm()
    })

    expect(recordBreadcrumbMock).toHaveBeenCalledWith('terminal_mass_kill', {
      source: 'orphan-sweep',
      count: 2
    })
    expect(killMock).toHaveBeenCalledTimes(2)
    expect(killMock).toHaveBeenCalledWith('a')
    expect(killMock).toHaveBeenCalledWith('b')
    expect(refreshSessions).toHaveBeenCalledTimes(1)
    expect(result.current.pending).toBeNull()
    expect(result.current.isKilling).toBe(false)
  })

  it('does not kill a staged orphan that becomes bound before confirm', async () => {
    const setSessions = vi.fn()
    const refreshSessions = vi.fn()
    let bound = new Set<string>()
    const { result } = renderHook(() =>
      useOrphanKillGate({ setSessions, refreshSessions, getBoundPtyIds: () => bound })
    )

    act(() => {
      result.current.request([makeSession('a'), makeSession('b')])
    })
    // 'a' gets adopted by a tab (reconnect/restore) while the confirm dialog sits open.
    bound = new Set(['a'])

    await act(async () => {
      await result.current.confirm()
    })

    expect(killMock).toHaveBeenCalledTimes(1)
    expect(killMock).toHaveBeenCalledWith('b')
    expect(killMock).not.toHaveBeenCalledWith('a')
    expect(recordBreadcrumbMock).toHaveBeenCalledWith('terminal_mass_kill', {
      source: 'orphan-sweep',
      count: 1
    })
    expect(result.current.pending).toBeNull()
  })

  it('kills nothing and records no breadcrumb when every staged orphan rebinds before confirm', async () => {
    const setSessions = vi.fn()
    const refreshSessions = vi.fn()
    let bound = new Set<string>()
    const { result } = renderHook(() =>
      useOrphanKillGate({ setSessions, refreshSessions, getBoundPtyIds: () => bound })
    )

    act(() => {
      result.current.request([makeSession('a'), makeSession('b')])
    })
    bound = new Set(['a', 'b'])

    await act(async () => {
      await result.current.confirm()
    })

    expect(killMock).not.toHaveBeenCalled()
    expect(recordBreadcrumbMock).not.toHaveBeenCalled()
    expect(refreshSessions).not.toHaveBeenCalled()
    expect(result.current.pending).toBeNull()
  })

  it('does nothing on confirm when no orphans are staged', async () => {
    const { result } = renderHook(() =>
      useOrphanKillGate({
        setSessions: vi.fn(),
        refreshSessions: vi.fn(),
        getBoundPtyIds: () => new Set<string>()
      })
    )

    await act(async () => {
      await result.current.confirm()
    })

    expect(killMock).not.toHaveBeenCalled()
    expect(recordBreadcrumbMock).not.toHaveBeenCalled()
  })

  it('clears staged orphans on cancel without killing', () => {
    const { result } = renderHook(() =>
      useOrphanKillGate({
        setSessions: vi.fn(),
        refreshSessions: vi.fn(),
        getBoundPtyIds: () => new Set<string>()
      })
    )

    act(() => {
      result.current.request([makeSession('a')])
    })
    act(() => {
      result.current.cancel()
    })

    expect(result.current.pending).toBeNull()
    expect(killMock).not.toHaveBeenCalled()
  })
})
