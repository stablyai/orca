// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ComputerAwakeStatus } from '../../../shared/computer-awake-mode'
import { useComputerAwakeStatus } from './computer-awake-status'

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

function installAgentAwakeApi(options: {
  getStatus: () => Promise<ComputerAwakeStatus>
  onChanged: (listener: (status: ComputerAwakeStatus) => void) => () => void
}): void {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { agentAwake: options }
  })
}

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, 'api')
})

describe('useComputerAwakeStatus', () => {
  it('loads the current main-process status', async () => {
    const status: ComputerAwakeStatus = { mode: 'auto', active: true }
    installAgentAwakeApi({
      getStatus: () => Promise.resolve(status),
      onChanged: () => () => {}
    })

    const view = renderHook(() => useComputerAwakeStatus())
    await act(() => Promise.resolve())

    expect(view.result.current).toEqual(status)
  })

  it('keeps a newer event when the initial snapshot resolves late', async () => {
    const initial = deferred<ComputerAwakeStatus>()
    const unsubscribe = vi.fn()
    let publish: ((status: ComputerAwakeStatus) => void) | undefined
    installAgentAwakeApi({
      getStatus: () => initial.promise,
      onChanged: (listener) => {
        publish = listener
        return unsubscribe
      }
    })
    const view = renderHook(() => useComputerAwakeStatus())
    const latest: ComputerAwakeStatus = {
      mode: 'auto',
      active: true,
      macosEngine: 'amphetamine',
      amphetamineActive: true
    }

    act(() => publish?.(latest))
    await act(async () => {
      initial.resolve({ mode: 'off', active: false })
      await initial.promise
    })

    expect(view.result.current).toEqual(latest)
    view.unmount()
    expect(unsubscribe).toHaveBeenCalledOnce()
  })
})
