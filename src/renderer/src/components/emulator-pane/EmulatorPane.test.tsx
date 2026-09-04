// @vitest-environment happy-dom
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import EmulatorPane from './EmulatorPane'
import type {
  EmulatorZoomAction,
  EmulatorZoomMetrics,
  EmulatorZoomState
} from './emulator-pane-zoom'

type CapturedFrameProps = {
  onZoomMetrics?: (metrics: EmulatorZoomMetrics | null) => void
  zoomState?: EmulatorZoomState
}

type CapturedToolbarProps = {
  androidControls?: {
    onZoomChange?: (action: EmulatorZoomAction) => void
  }
}

const mocks = vi.hoisted(() => ({
  frameProps: { current: null as CapturedFrameProps | null },
  toolbarProps: { current: null as CapturedToolbarProps | null }
}))

vi.mock('./use-emulator-pane-session', () => ({
  useEmulatorPaneSession: () => ({
    devices: [
      {
        name: 'Pixel 9 Pro',
        udid: 'emulator-5554',
        state: 'Booted',
        runtime: 'emulator',
        backend: 'android',
        controlCapabilities: { power: true, volume: true, overview: true, shutdown: true }
      }
    ],
    selectedUdid: 'emulator-5554',
    setSelectedUdid: vi.fn(),
    loading: false,
    error: null,
    attach: vi.fn(),
    shutdown: vi.fn(),
    sendTap: vi.fn(),
    sendButton: vi.fn(),
    sendGesture: vi.fn(),
    sendRotate: vi.fn(),
    sendPosture: vi.fn(),
    displayCommandPending: false,
    displayName: 'Pixel 9 Pro',
    previewUrl: undefined,
    wsUrl: 'ws://emulator',
    streamKey: 'stream-1',
    isLive: true,
    visualOrientation: 'portrait',
    selectedDevice: {
      name: 'Pixel 9 Pro',
      udid: 'emulator-5554',
      state: 'Booted',
      runtime: 'emulator',
      backend: 'android',
      controlCapabilities: { power: true, volume: true, overview: true, shutdown: true }
    },
    session: { attached: true, info: { backend: 'android', deviceUdid: 'emulator-5554' } }
  })
}))

vi.mock('./emulator-pane-toolbar', () => ({
  EmulatorPaneToolbar: (props: CapturedToolbarProps) => {
    mocks.toolbarProps.current = props
    return null
  }
}))

vi.mock('./emulator-device-frame', () => ({
  EmulatorDeviceFrame: (props: CapturedFrameProps) => {
    mocks.frameProps.current = props
    return null
  }
}))

vi.mock('./MobileEmulatorAgentSetupGuideLayer', () => ({
  MobileEmulatorAgentSetupGuideLayer: ({ children }: { children: unknown }) => children
}))

afterEach(() => {
  cleanup()
  mocks.frameProps.current = null
  mocks.toolbarProps.current = null
})

describe('EmulatorPane zoom integration', () => {
  it('passes frame metrics into zoom state and sends Zoom In through the toolbar', () => {
    render(<EmulatorPane worktreeId="worktree-1" />)

    const frameProps = mocks.frameProps.current
    const toolbarProps = mocks.toolbarProps.current
    const onZoomMetrics = frameProps?.onZoomMetrics
    expect(onZoomMetrics).toEqual(expect.any(Function))
    expect(toolbarProps?.androidControls?.onZoomChange).toEqual(expect.any(Function))
    if (!onZoomMetrics) {
      throw new Error('Expected frame zoom metrics callback')
    }

    act(() => {
      onZoomMetrics({
        fitScale: 0.4,
        fitDisplayScale: 0.3
      })
    })
    const onZoomChange = mocks.toolbarProps.current?.androidControls?.onZoomChange
    expect(onZoomChange).toEqual(expect.any(Function))
    if (!onZoomChange) {
      throw new Error('Expected toolbar zoom callback')
    }
    act(() => {
      onZoomChange('in')
    })

    expect(mocks.frameProps.current?.zoomState).toEqual({ mode: 'fixed', scale: 0.5 })
  })
})
