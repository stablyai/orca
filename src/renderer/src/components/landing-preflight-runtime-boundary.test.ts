// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PreflightStatus } from '../../../preload/api-types'
import type { Repo } from '../../../shared/repo-types'
import { useAppStore } from '../store'
import { useLandingPreflightRuntime } from './landing-preflight-runtime'

const refresh = vi.fn().mockResolvedValue(undefined)
const invalidate = vi.fn()

const status = (overrides: Partial<PreflightStatus> = {}): PreflightStatus => ({
  git: { installed: true },
  gh: { installed: false, authenticated: false },
  ...overrides
})

function setDocumentVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state })
  document.dispatchEvent(new Event('visibilitychange'))
}

const githubRepo: Repo = {
  id: 'github',
  path: '/repos/github',
  displayName: 'github',
  badgeColor: '#000000',
  addedAt: 0,
  kind: 'git',
  upstream: { owner: 'orca', repo: 'orca' }
}

beforeEach(() => {
  vi.useFakeTimers()
  setDocumentVisibility('visible')
  refresh.mockClear()
  invalidate.mockClear()
  useAppStore.setState(useAppStore.getInitialState(), true)
  useAppStore.setState({ refreshPreflightStatus: refresh, invalidatePreflightStatus: invalidate })
})

afterEach(() => {
  cleanup()
  setDocumentVisibility('visible')
  vi.useRealTimers()
  useAppStore.setState(useAppStore.getInitialState(), true)
})

describe('landing preflight runtime boundary', () => {
  it('refreshes after an active runtime A to B switch without manual action', () => {
    const view = renderHook(() => useLandingPreflightRuntime())
    expect(refresh).toHaveBeenCalledTimes(1)

    act(() => {
      useAppStore.setState({
        settings: { activeRuntimeEnvironmentId: 'runtime-a' },
        runtimeStatusByEnvironmentId: new Map([
          ['runtime-a', { status: { runtimeId: 'a' }, connectionGeneration: 1 }]
        ])
      } as never)
    })
    act(() => {
      useAppStore.setState({
        settings: { activeRuntimeEnvironmentId: 'runtime-b' },
        runtimeStatusByEnvironmentId: new Map([
          ['runtime-b', { status: { runtimeId: 'b' }, connectionGeneration: 1 }]
        ])
      } as never)
    })

    expect(refresh).toHaveBeenCalledTimes(3)
    view.unmount()
  })

  it('invalidates on disconnect and refreshes exactly once on reconnect', () => {
    const view = renderHook(() => useLandingPreflightRuntime())
    act(() => {
      useAppStore.setState({
        settings: { activeRuntimeEnvironmentId: 'runtime-a' },
        runtimeStatusByEnvironmentId: new Map([
          ['runtime-a', { status: { runtimeId: 'a' }, connectionGeneration: 1 }]
        ])
      } as never)
    })
    refresh.mockClear()

    act(() => {
      useAppStore.setState({
        runtimeStatusByEnvironmentId: new Map([
          ['runtime-a', { status: null, connectionGeneration: 2 }]
        ])
      } as never)
    })
    expect(invalidate).toHaveBeenCalledTimes(1)
    expect(refresh).not.toHaveBeenCalled()

    act(() => {
      useAppStore.setState({
        runtimeStatusByEnvironmentId: new Map([
          ['runtime-a', { status: { runtimeId: 'a-reconnected' }, connectionGeneration: 3 }]
        ])
      } as never)
    })
    expect(refresh).toHaveBeenCalledTimes(1)
    view.unmount()
  })

  it('keeps the banner empty while the active remote runtime is still unknown', () => {
    useAppStore.setState({ settings: { activeRuntimeEnvironmentId: 'runtime-a' } } as never)

    const view = renderHook(() => useLandingPreflightRuntime())

    expect(invalidate).toHaveBeenCalledTimes(1)
    expect(refresh).not.toHaveBeenCalled()
    view.unmount()
  })

  it('stops the 30s preflight poll while hidden and lets the reveal refresh instead', () => {
    useAppStore.setState({ repos: [githubRepo], preflightStatus: status() })
    const view = renderHook(() => useLandingPreflightRuntime())
    refresh.mockClear()

    expect(vi.getTimerCount()).toBe(1)
    act(() => setDocumentVisibility('hidden'))
    expect(vi.getTimerCount()).toBe(0)

    // Five poll windows pass behind a hidden window with no IPC at all.
    act(() => vi.advanceTimersByTime(150_000))
    expect(refresh).not.toHaveBeenCalled()

    // The sibling visibilitychange handler force-refreshes on reveal, so the
    // banner is current the moment it can be seen; the poll re-arms behind it.
    act(() => setDocumentVisibility('visible'))
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(refresh).toHaveBeenCalledWith({ force: true })
    expect(vi.getTimerCount()).toBe(1)

    view.unmount()
  })

  it('keeps one active interval and removes listeners and polling on cleanup', () => {
    useAppStore.setState({ repos: [githubRepo], preflightStatus: status() })
    const addEventListener = vi.spyOn(document, 'addEventListener')
    const removeEventListener = vi.spyOn(document, 'removeEventListener')
    const addWindowListener = vi.spyOn(window, 'addEventListener')
    const removeWindowListener = vi.spyOn(window, 'removeEventListener')
    const view = renderHook(() => useLandingPreflightRuntime())

    expect(vi.getTimerCount()).toBe(1)
    act(() => {
      useAppStore.setState({ repos: [...useAppStore.getState().repos] })
    })
    expect(vi.getTimerCount()).toBe(1)
    act(() => vi.advanceTimersByTime(30_000))
    expect(refresh).toHaveBeenCalledWith({ force: true })

    view.unmount()
    expect(vi.getTimerCount()).toBe(0)
    expect(removeEventListener).toHaveBeenCalledWith('visibilitychange', expect.any(Function))
    expect(removeWindowListener).toHaveBeenCalledWith('focus', expect.any(Function))
    expect(addEventListener).toHaveBeenCalledWith('visibilitychange', expect.any(Function))
    expect(addWindowListener).toHaveBeenCalledWith('focus', expect.any(Function))
    addEventListener.mockRestore()
    removeEventListener.mockRestore()
    addWindowListener.mockRestore()
    removeWindowListener.mockRestore()
  })
})
