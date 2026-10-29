// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { watchRuntimeRepoBaseRefDefault } from './runtime-repo-client'

const getBaseRefDefault = vi.fn()
const distroRunningListeners = new Set<(distro: string) => void>()

function emitDistroRunning(distro: string): void {
  for (const listener of distroRunningListeners) {
    listener(distro)
  }
}

beforeEach(() => {
  getBaseRefDefault.mockReset()
  distroRunningListeners.clear()
  vi.stubGlobal('window', {
    api: {
      repos: { getBaseRefDefault },
      preflight: {
        onWslDistroRunning: (listener: (distro: string) => void) => {
          distroRunningListeners.add(listener)
          return () => distroRunningListeners.delete(listener)
        }
      }
    }
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const REFUSED = { defaultBaseRef: null, remoteCount: 0, refusedWslDistro: 'Ubuntu' }
const LOADED = { defaultBaseRef: 'origin/main', remoteCount: 1 }

describe('watchRuntimeRepoBaseRefDefault after a stopped-distro refusal (E9)', () => {
  it('loads again once the refusing distro runs', async () => {
    getBaseRefDefault.mockResolvedValueOnce(REFUSED).mockResolvedValueOnce(LOADED)
    const onResult = vi.fn()
    watchRuntimeRepoBaseRefDefault('local', 'repo-1', { onResult, onError: vi.fn() })
    await vi.waitFor(() => expect(onResult).toHaveBeenCalledWith(REFUSED))

    emitDistroRunning('ubuntu')

    await vi.waitFor(() => expect(onResult).toHaveBeenLastCalledWith(LOADED))
    expect(getBaseRefDefault).toHaveBeenCalledTimes(2)
    expect(distroRunningListeners.size).toBe(0)
  })

  it('ignores other distros', async () => {
    getBaseRefDefault.mockResolvedValue(REFUSED)
    const onResult = vi.fn()
    watchRuntimeRepoBaseRefDefault('local', 'repo-1', { onResult, onError: vi.fn() })
    await vi.waitFor(() => expect(distroRunningListeners.size).toBe(1))

    emitDistroRunning('Debian')

    expect(getBaseRefDefault).toHaveBeenCalledTimes(1)
  })

  it('stops listening when cancelled', async () => {
    getBaseRefDefault.mockResolvedValue(REFUSED)
    const cancel = watchRuntimeRepoBaseRefDefault('local', 'repo-1', {
      onResult: vi.fn(),
      onError: vi.fn()
    })
    await vi.waitFor(() => expect(distroRunningListeners.size).toBe(1))

    cancel()
    emitDistroRunning('Ubuntu')

    expect(distroRunningListeners.size).toBe(0)
    expect(getBaseRefDefault).toHaveBeenCalledTimes(1)
  })

  it('does not listen after a result that was not refused', async () => {
    getBaseRefDefault.mockResolvedValue(LOADED)
    const onResult = vi.fn()
    watchRuntimeRepoBaseRefDefault('local', 'repo-1', { onResult, onError: vi.fn() })
    await vi.waitFor(() => expect(onResult).toHaveBeenCalledWith(LOADED))

    expect(distroRunningListeners.size).toBe(0)
  })
})
