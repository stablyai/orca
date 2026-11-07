import * as emulatorPreferences from '@/lib/emulator-opening-preferences-capability'
import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/hosts/capabilities/local-runtime-capabilities'
// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import {
  consumePrelaunchedSimulatorSession,
  rememberPrelaunchedSimulatorSession
} from '@/lib/simulator-launch-coordination'
import { cancelPendingSimulatorPaneShutdown } from '@/lib/simulator-pane-shutdown-scheduler'
import { useEmulatorPaneSession } from './use-emulator-pane-session'
import type { SimulatorDeviceRow } from './emulator-pane-types'

type RuntimeCallRequest = {
  method: string
  params?: unknown
}

type AttachResult = {
  attached: boolean
  info: {
    deviceUdid: string
    displayName: string
    streamUrl: string
    wsUrl: string
  }
}

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
}

const WORKTREE_ID = 'wt-emulator-session-test'

const devices: SimulatorDeviceRow[] = [
  { name: 'iPhone A', udid: 'device-a', state: 'Booted', isAvailable: true },
  { name: 'iPhone B', udid: 'device-b', state: 'Shutdown', isAvailable: true }
]

const deviceList = devices.map((device) => ({
  backend: 'ios' as const,
  id: device.udid,
  name: device.name,
  state: device.state === 'Booted' ? ('booted' as const) : ('shutdown' as const),
  isAvailable: device.isAvailable
}))

let attachDeferred: Deferred<AttachResult>
let rotateDeferred: Deferred<void>
let container: HTMLDivElement
let root: Root
let latest: ReturnType<typeof useEmulatorPaneSession> | null = null

function createDeferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

function runtimeSuccess<T>(result: T) {
  return {
    id: 'test',
    ok: true as const,
    result,
    _meta: { runtimeId: 'test-runtime' }
  }
}

function runtimeFailure(code: string, message: string) {
  return {
    id: 'test',
    ok: false,
    error: { code, message },
    _meta: { runtimeId: 'test-runtime' }
  }
}

function Probe(): React.JSX.Element {
  const state = useEmulatorPaneSession({
    worktreeId: WORKTREE_ID,
    autoAttachOnMount: false
  })
  latest = state
  return (
    <button type="button" onClick={() => void state.attach('device-b')}>
      Switch
    </button>
  )
}

function AutoAttachProbe(): React.JSX.Element | null {
  latest = useEmulatorPaneSession({
    worktreeId: WORKTREE_ID,
    autoAttachOnMount: true
  })
  return null
}

async function flushEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('useEmulatorPaneSession', () => {
  beforeEach(() => {
    setLocalRuntimeCapabilitiesForTests([])
    ;(
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true
    attachDeferred = createDeferred<AttachResult>()
    rotateDeferred = createDeferred<void>()
    latest = null
    consumePrelaunchedSimulatorSession(WORKTREE_ID)
    rememberPrelaunchedSimulatorSession(WORKTREE_ID, {
      deviceUdid: 'device-a',
      displayName: 'iPhone A',
      streamUrl: 'http://127.0.0.1:3100/stream.mjpeg',
      wsUrl: 'ws://127.0.0.1:3100/ws'
    })
    useAppStore.setState({ settings: null })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        runtime: {
          call: vi.fn(async ({ method }: RuntimeCallRequest) => {
            if (method === 'emulator.listDevices') {
              return runtimeSuccess(deviceList)
            }
            if (method === 'emulator.attach') {
              return runtimeSuccess(await attachDeferred.promise)
            }
            if (method === 'emulator.rotate') {
              return runtimeSuccess(await rotateDeferred.promise)
            }
            if (method === 'emulator.shutdown') {
              return runtimeSuccess({ deviceUdid: 'device-b' })
            }
            throw new Error(`Unexpected RPC method: ${method}`)
          })
        }
      }
    })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => {
      root.unmount()
    })
    cancelPendingSimulatorPaneShutdown(WORKTREE_ID)
    container.remove()
    consumePrelaunchedSimulatorSession(WORKTREE_ID)
    delete (window as { api?: unknown }).api
    vi.restoreAllMocks()
  })

  it('retains an explicit session when an older automatic capability lookup finishes', async () => {
    consumePrelaunchedSimulatorSession(WORKTREE_ID)
    const capability = createDeferred<boolean>()
    vi.spyOn(emulatorPreferences, 'supportsEmulatorOpeningPreferences')
      .mockImplementationOnce(() => capability.promise)
      .mockResolvedValue(true)
    let attachCalls = 0
    vi.mocked(window.api.runtime.call).mockImplementation(async (request) => {
      if (request.method === 'emulator.listDevices') {
        return runtimeSuccess(deviceList)
      }
      if (++attachCalls > 1) {
        return runtimeSuccess(await attachDeferred.promise)
      }
      return runtimeSuccess({
        attached: true,
        info: {
          deviceUdid: 'device-b',
          displayName: 'iPhone B',
          streamUrl: 'http://127.0.0.1:3200/stream.mjpeg',
          wsUrl: 'ws://127.0.0.1:3200/ws'
        }
      })
    })
    await act(async () => root.render(<AutoAttachProbe />))
    await flushEffects()
    expect(latest?.loading).toBe(true)
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('orca:emulator-auto-attach', {
          detail: {
            worktreeId: WORKTREE_ID,
            info: {
              deviceUdid: 'device-a',
              streamUrl: 'http://127.0.0.1:3100/stream.mjpeg'
            }
          }
        })
      )
    })
    await act(async () => {
      await latest?.attach('device-b')
    })
    expect(latest?.isLive).toBe(true)
    expect(latest?.selectedUdid).toBe('device-b')
    await act(async () => capability.resolve(true))
    await flushEffects()
    expect(latest?.isLive).toBe(true)
    expect(latest?.previewUrl).toBe('http://127.0.0.1:3200/stream.mjpeg')
    expect(latest?.displayName).toBe('iPhone B')
  })

  it('ignores a rotate response from the previous session after switching devices', async () => {
    await act(async () => {
      root.render(<Probe />)
    })
    await flushEffects()

    let rotatePromise: Promise<unknown> = Promise.resolve()
    await act(async () => {
      rotatePromise = latest?.sendRotate() ?? Promise.resolve()
      await Promise.resolve()
    })

    await act(async () => {
      container.querySelector('button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })

    await act(async () => {
      rotateDeferred.resolve()
      await rotatePromise
      await Promise.resolve()
    })

    expect(latest?.visualOrientation).toBe('portrait')

    await act(async () => {
      attachDeferred.resolve({
        attached: true,
        info: {
          deviceUdid: 'device-b',
          displayName: 'iPhone B',
          streamUrl: 'http://127.0.0.1:3200/stream.mjpeg',
          wsUrl: 'ws://127.0.0.1:3200/ws'
        }
      })
      await attachDeferred.promise
      await Promise.resolve()
    })

    expect(latest?.visualOrientation).toBe('portrait')
  })

  it('keeps simulator discovery setup errors during auto attach', async () => {
    const message =
      'Xcode Simulator tools are unavailable. Install full Xcode, open it once, then select it with `sudo xcode-select --switch /Applications/Xcode.app/Contents/Developer`.'
    consumePrelaunchedSimulatorSession(WORKTREE_ID)
    const runtimeCall = vi.fn(async ({ method }: RuntimeCallRequest) => {
      if (method === 'emulator.listDevices') {
        return runtimeFailure('emulator_simctl_unavailable', message)
      }
      if (method === 'emulator.attach') {
        throw new Error('attach should not run without a discovered target')
      }
      throw new Error(`Unexpected RPC method: ${method}`)
    })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { runtime: { call: runtimeCall } }
    })

    await act(async () => {
      root.render(<AutoAttachProbe />)
    })

    await vi.waitFor(() => expect(latest?.error).toBe(message))
    expect(latest?.loading).toBe(false)
    expect(runtimeCall).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'emulator.attach' })
    )
  })
})
