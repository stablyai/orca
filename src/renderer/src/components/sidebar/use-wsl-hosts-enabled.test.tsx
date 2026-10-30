// @vitest-environment happy-dom
import { act } from 'react'
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import {
  useWslHostsAcceptNewWork,
  useWslHostsEnabled,
  useWslHostsPaused
} from './use-wsl-hosts-enabled'

describe('WSL host entry points in serve-only', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    vi.stubGlobal('api', { runtimeEnvironments: { wslHosts: {} } })
    act(() => {
      useAppStore.setState({
        settings: { ...useAppStore.getState().settings!, experimentalWslHosts: true },
        wslHostsAcceptNewWork: true
      })
    })
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('offers nothing new until main answers the capability, so Add and Move never flash', () => {
    expect(useAppStore.getInitialState().wslHostsAcceptNewWork).toBe(false)
  })

  it('offers adding hosts and moving projects with the gate open', () => {
    const accepts = renderHook(() => useWslHostsAcceptNewWork())
    expect(accepts.result.current).toBe(true)
  })

  it('keeps saved hosts enabled but offers no new host or move once main reports serve-only', () => {
    const accepts = renderHook(() => useWslHostsAcceptNewWork())
    const enabled = renderHook(() => useWslHostsEnabled())

    act(() => useAppStore.getState().setWslHostsAcceptNewWork(false))

    expect(accepts.result.current).toBe(false)
    expect(enabled.result.current).toBe(true)
  })

  it('shows the paused notice only once main answers serve-only, never before or when open', () => {
    act(() => useAppStore.setState({ wslHostsNewWorkPaused: false }))
    const paused = renderHook(() => useWslHostsPaused())
    expect(paused.result.current).toBe(false)

    act(() => useAppStore.getState().setWslHostsAcceptNewWork(true))
    expect(paused.result.current).toBe(false)

    act(() => useAppStore.getState().setWslHostsAcceptNewWork(false))
    expect(paused.result.current).toBe(true)
  })

  it('shows no paused notice where WSL hosts are not exposed at all (closed)', () => {
    vi.stubGlobal('api', { runtimeEnvironments: {} })
    act(() => useAppStore.getState().setWslHostsAcceptNewWork(false))
    expect(renderHook(() => useWslHostsPaused()).result.current).toBe(false)
  })
})
