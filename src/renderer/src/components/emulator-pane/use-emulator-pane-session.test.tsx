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

let attachDeferred: Deferred<AttachResult>
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
    ok: true,
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
    ;(
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true
    attachDeferred = createDeferred<AttachResult>()
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
            if (method === 'emulator.listSimulators') {
              return runtimeSuccess(devices)
            }
            if (method === 'emulator.attach') {
              return runtimeSuccess(await attachDeferred.promise)
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

  it('shows a connecting state instead of the old live preview while switching devices', async () => {
    await act(async () => {
      root.render(<Probe />)
    })
    await flushEffects()

    expect(latest?.isLive).toBe(true)
    expect(latest?.previewUrl).toBe('http://127.0.0.1:3100/stream.mjpeg')

    await act(async () => {
      container.querySelector('button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })

    expect(latest?.loading).toBe(true)
    expect(latest?.isLive).toBe(false)
    expect(latest?.previewUrl).toBeUndefined()
    expect(latest?.displayName).toBe('iPhone B')
    expect(latest?.selectedUdid).toBe('device-b')

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

    expect(latest?.loading).toBe(false)
    expect(latest?.isLive).toBe(true)
    expect(latest?.previewUrl).toBe('http://127.0.0.1:3200/stream.mjpeg')
  })

  it('keeps simulator discovery setup errors during auto attach', async () => {
    const message =
      'Xcode Simulator tools are unavailable. Install full Xcode, open it once, then select it with `sudo xcode-select --switch /Applications/Xcode.app/Contents/Developer`.'
    consumePrelaunchedSimulatorSession(WORKTREE_ID)
    const runtimeCall = vi.fn(async ({ method }: RuntimeCallRequest) => {
      if (method === 'emulator.listSimulators') {
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
