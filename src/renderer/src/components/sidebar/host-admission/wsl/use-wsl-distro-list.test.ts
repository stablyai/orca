// @vitest-environment happy-dom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WslHostDistro } from '../../../../../../shared/wsl-host-types'
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
})
