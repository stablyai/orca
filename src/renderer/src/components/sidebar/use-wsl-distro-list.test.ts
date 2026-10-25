// @vitest-environment happy-dom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WslHostDistro } from '../../../../shared/wsl-host-types'
import { useWslDistroList } from './use-wsl-distro-list'

const ubuntu: WslHostDistro = { name: 'Ubuntu', state: 'running', version: 2, environmentId: null }
const debian: WslHostDistro = { name: 'Debian', state: 'stopped', version: 2, environmentId: null }

let listDistros: ReturnType<typeof vi.fn>

beforeEach(() => {
  listDistros = vi.fn()
  Object.assign(window, { api: { runtimeEnvironments: { wslHosts: { listDistros } } } })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('useWslDistroList', () => {
  it('re-reads when the window regains focus, so a distro imported meanwhile appears', async () => {
    listDistros.mockResolvedValueOnce([ubuntu]).mockResolvedValueOnce([ubuntu, debian])
    const { result } = renderHook(() => useWslDistroList(true))
    await waitFor(() => expect(result.current.distros).toEqual([ubuntu]))
    expect(result.current.loading).toBe(false)

    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    await waitFor(() => expect(result.current.distros).toEqual([ubuntu, debian]))
    expect(listDistros).toHaveBeenCalledTimes(2)
  })

  it('re-reads on visibility return and on demand, but never on its own', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    listDistros.mockResolvedValue([ubuntu])
    const { result } = renderHook(() => useWslDistroList(true))
    await waitFor(() => expect(result.current.loading).toBe(false))
    vi.advanceTimersByTime(60_000)
    expect(listDistros).toHaveBeenCalledTimes(1)

    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await waitFor(() => expect(result.current.refreshing).toBe(false))
    expect(listDistros).toHaveBeenCalledTimes(2)

    act(() => result.current.refresh())
    await waitFor(() => expect(listDistros).toHaveBeenCalledTimes(3))
  })

  it('reads nothing when disabled', () => {
    const { result } = renderHook(() => useWslDistroList(false))
    expect(result.current.loading).toBe(false)
    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    expect(listDistros).not.toHaveBeenCalled()
  })
})
