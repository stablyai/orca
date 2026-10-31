// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const rpc = vi.hoisted(() => vi.fn())
vi.mock('./runtime-rpc-client', () => ({ callRuntimeRpc: rpc }))

import { REFUSED_BASE_REF_REPOLL_MS, watchRuntimeRepoBaseRefDefault } from './runtime-repo-client'

const getBaseRefDefault = vi.fn()
const distroRunningListeners = new Set<(distro: string) => void>()
const focusListeners = new Set<() => void>()
const page = { visibilityState: 'visible' }

function emitDistroRunning(distro: string): void {
  for (const listener of distroRunningListeners) {
    listener(distro)
  }
}

function focusWindow(): void {
  for (const listener of focusListeners) {
    listener()
  }
}

type PreflightStub = {
  onWslDistroRunning?: (listener: (distro: string) => void) => () => void
}

function stubWindow(preflight: PreflightStub): void {
  vi.stubGlobal('window', {
    api: { repos: { getBaseRefDefault }, preflight },
    addEventListener: (type: string, listener: () => void) => {
      if (type === 'focus') {
        focusListeners.add(listener)
      }
    },
    removeEventListener: (type: string, listener: () => void) => {
      if (type === 'focus') {
        focusListeners.delete(listener)
      }
    }
  })
}

const hearsRunningSignal: PreflightStub = {
  onWslDistroRunning: (listener: (distro: string) => void) => {
    distroRunningListeners.add(listener)
    return () => distroRunningListeners.delete(listener)
  }
}

beforeEach(() => {
  getBaseRefDefault.mockReset()
  rpc.mockReset()
  distroRunningListeners.clear()
  focusListeners.clear()
  page.visibilityState = 'visible'
  vi.stubGlobal('document', page)
  stubWindow(hearsRunningSignal)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const REFUSED = { defaultBaseRef: null, remoteCount: 0, refusedWslDistro: 'Ubuntu' }
const LOADED = { defaultBaseRef: 'origin/main', remoteCount: 1 }

describe("watchRuntimeRepoBaseRefDefault on this app's repos (E9)", () => {
  it('loads again once the refusing distro runs', async () => {
    getBaseRefDefault.mockResolvedValueOnce(REFUSED).mockResolvedValueOnce(LOADED)
    const onResult = vi.fn()
    watchRuntimeRepoBaseRefDefault('local', 'repo-1', { onResult, onError: vi.fn() })
    await vi.waitFor(() => expect(onResult).toHaveBeenCalledWith(REFUSED))

    emitDistroRunning('ubuntu')

    await vi.waitFor(() => expect(onResult).toHaveBeenLastCalledWith(LOADED))
    expect(getBaseRefDefault).toHaveBeenCalledTimes(2)
  })

  it('re-asks when the distro started while main was still answering', async () => {
    let answer: (value: typeof REFUSED) => void = () => {}
    getBaseRefDefault
      .mockReturnValueOnce(new Promise((resolve) => (answer = resolve)))
      .mockResolvedValueOnce(LOADED)
    const onResult = vi.fn()
    watchRuntimeRepoBaseRefDefault('local', 'repo-1', { onResult, onError: vi.fn() })

    emitDistroRunning('Ubuntu')
    answer(REFUSED)

    await vi.waitFor(() => expect(onResult).toHaveBeenLastCalledWith(LOADED))
    expect(getBaseRefDefault).toHaveBeenCalledTimes(2)
  })

  it('ignores other distros', async () => {
    getBaseRefDefault.mockResolvedValue(REFUSED)
    const onResult = vi.fn()
    watchRuntimeRepoBaseRefDefault('local', 'repo-1', { onResult, onError: vi.fn() })
    await vi.waitFor(() => expect(onResult).toHaveBeenCalledWith(REFUSED))

    emitDistroRunning('Debian')

    expect(getBaseRefDefault).toHaveBeenCalledTimes(1)
  })

  it('does not re-ask after a result that was not refused', async () => {
    getBaseRefDefault.mockResolvedValue(LOADED)
    const onResult = vi.fn()
    watchRuntimeRepoBaseRefDefault('local', 'repo-1', { onResult, onError: vi.fn() })
    await vi.waitFor(() => expect(onResult).toHaveBeenCalledWith(LOADED))

    emitDistroRunning('Ubuntu')

    expect(getBaseRefDefault).toHaveBeenCalledTimes(1)
  })

  it('stops listening when cancelled', async () => {
    getBaseRefDefault.mockResolvedValue(REFUSED)
    const onResult = vi.fn()
    const cancel = watchRuntimeRepoBaseRefDefault('local', 'repo-1', {
      onResult,
      onError: vi.fn()
    })
    await vi.waitFor(() => expect(onResult).toHaveBeenCalledWith(REFUSED))

    cancel()
    emitDistroRunning('Ubuntu')

    expect(distroRunningListeners.size).toBe(0)
    expect(getBaseRefDefault).toHaveBeenCalledTimes(1)
  })
})

describe('watchRuntimeRepoBaseRefDefault on a paired host (E9)', () => {
  const PAIRED = 'runtime:env-1'

  it('re-asks on window focus while the host refuses', async () => {
    rpc.mockResolvedValueOnce(REFUSED).mockResolvedValueOnce(LOADED)
    const onResult = vi.fn()
    watchRuntimeRepoBaseRefDefault(PAIRED, 'repo-1', { onResult, onError: vi.fn() })
    await vi.waitFor(() => expect(onResult).toHaveBeenCalledWith(REFUSED))
    expect(distroRunningListeners.size).toBe(0)

    focusWindow()

    await vi.waitFor(() => expect(onResult).toHaveBeenLastCalledWith(LOADED))
    focusWindow()
    expect(rpc).toHaveBeenCalledTimes(2)
  })

  it('re-asks every 30 s while visible, and stops once answered', async () => {
    vi.useFakeTimers()
    rpc.mockResolvedValueOnce(REFUSED).mockResolvedValueOnce(REFUSED).mockResolvedValueOnce(LOADED)
    const onResult = vi.fn()
    watchRuntimeRepoBaseRefDefault(PAIRED, 'repo-1', { onResult, onError: vi.fn() })
    await vi.advanceTimersByTimeAsync(0)

    page.visibilityState = 'hidden'
    await vi.advanceTimersByTimeAsync(REFUSED_BASE_REF_REPOLL_MS)
    expect(rpc).toHaveBeenCalledTimes(1)

    page.visibilityState = 'visible'
    await vi.advanceTimersByTimeAsync(REFUSED_BASE_REF_REPOLL_MS)
    expect(rpc).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(REFUSED_BASE_REF_REPOLL_MS)
    expect(onResult).toHaveBeenLastCalledWith(LOADED)

    await vi.advanceTimersByTimeAsync(REFUSED_BASE_REF_REPOLL_MS * 3)
    expect(rpc).toHaveBeenCalledTimes(3)
  })

  it('stops re-asking when cancelled', async () => {
    vi.useFakeTimers()
    rpc.mockResolvedValue(REFUSED)
    const cancel = watchRuntimeRepoBaseRefDefault(PAIRED, 'repo-1', {
      onResult: vi.fn(),
      onError: vi.fn()
    })
    await vi.advanceTimersByTimeAsync(0)

    cancel()
    focusWindow()
    await vi.advanceTimersByTimeAsync(REFUSED_BASE_REF_REPOLL_MS * 2)

    expect(rpc).toHaveBeenCalledTimes(1)
    expect(focusListeners.size).toBe(0)
  })

  it('polls a local-looking host whose preload has no running signal (web client)', async () => {
    stubWindow({})
    getBaseRefDefault.mockResolvedValueOnce(REFUSED).mockResolvedValueOnce(LOADED)
    const onResult = vi.fn()
    watchRuntimeRepoBaseRefDefault('local', 'repo-1', { onResult, onError: vi.fn() })
    await vi.waitFor(() => expect(onResult).toHaveBeenCalledWith(REFUSED))

    focusWindow()

    await vi.waitFor(() => expect(onResult).toHaveBeenLastCalledWith(LOADED))
  })
})
