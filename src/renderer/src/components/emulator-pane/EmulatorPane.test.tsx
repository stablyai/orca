// @vitest-environment happy-dom
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import EmulatorPane from './EmulatorPane'
import type { EmulatorDeviceControlCapabilities } from '../../../../shared/emulator-device-controls'
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
  onRotate?: () => void
  androidControls?: {
    capabilities?: EmulatorDeviceControlCapabilities
    onZoomChange?: (action: EmulatorZoomAction) => void
  }
}

const androidControlCapabilities: EmulatorDeviceControlCapabilities = {
  shutdown: false,
  power: true,
  volume: false,
  overview: true,
  foldable: true,
  wearButton1: false,
  wearButton2: true
}

const mocks = vi.hoisted(() => ({
  frameProps: { current: null as CapturedFrameProps | null },
  toolbarProps: { current: null as CapturedToolbarProps | null },
  sendRotate: vi.fn()
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
        controlCapabilities: androidControlCapabilities
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
    sendRotate: mocks.sendRotate,
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
      controlCapabilities: androidControlCapabilities
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
  mocks.sendRotate.mockReset()
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

describe('EmulatorPane Android controls integration', () => {
  it('forwards selected device control capabilities to the toolbar', () => {
    render(<EmulatorPane worktreeId="worktree-1" />)

    expect(mocks.toolbarProps.current?.androidControls?.capabilities).toEqual(
      androidControlCapabilities
    )
  })

  it('uses the legacy no-argument rotation callback for the pane toolbar', () => {
    render(<EmulatorPane worktreeId="worktree-1" />)

    const onRotate = mocks.toolbarProps.current?.onRotate
    expect(onRotate).toEqual(expect.any(Function))

    act(() => {
      onRotate?.()
    })

    expect(mocks.sendRotate).toHaveBeenCalledWith()
  })
})
