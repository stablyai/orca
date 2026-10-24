// @vitest-environment happy-dom

import { cleanup, renderHook } from '@testing-library/react'
import type React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DesktopAppWindow } from '../../../../shared/desktop-app-types'
import { useDesktopAppInput } from './use-desktop-app-input'

const sendInput = vi.fn(async () => ({ path: 'synthetic' }))
const target: DesktopAppWindow = {
  windowId: 1,
  pid: 42,
  appName: 'App',
  bundleId: null,
  title: 'App',
  bounds: { x: 0, y: 0, width: 100, height: 100 }
}

function videoElement() {
  const video = document.createElement('video')
  Object.defineProperty(video, 'videoWidth', { value: 100 })
  Object.defineProperty(video, 'videoHeight', { value: 100 })
  video.getBoundingClientRect = () => new DOMRect(0, 0, 100, 100)
  return video
}

function renderInput() {
  const videoRef = { current: videoElement() }
  return renderHook(() => useDesktopAppInput(target, videoRef, () => undefined))
}

function mouseEvent(type: 'pointer' | 'mouse', detail: number) {
  const currentTarget = videoElement()
  return {
    clientX: 10,
    clientY: 20,
    button: 0,
    detail,
    currentTarget,
    deltaX: 0,
    deltaY: 5,
    deltaMode: 0,
    type
  }
}

describe('useDesktopAppInput', () => {
  let frames: FrameRequestCallback[]

  beforeEach(() => {
    frames = []
    Object.defineProperty(window, 'api', {
      value: { desktopApp: { sendInput } },
      configurable: true
    })
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.push(cb))
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      frames[id - 1] = () => undefined
    })
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
    vi.unstubAllGlobals()
  })

  it('drops a scroll queued for the next frame when the view unmounts', () => {
    const { result, unmount } = renderInput()
    result.current.onWheel(mouseEvent('mouse', 0) as unknown as React.WheelEvent<HTMLElement>)
    unmount()
    frames.forEach((frame) => frame(0))
    expect(sendInput).not.toHaveBeenCalled()
  })

  it('sends the click count the mouseup reports', () => {
    const { result } = renderInput()
    result.current.onPointerDown(
      mouseEvent('pointer', 0) as unknown as React.PointerEvent<HTMLElement>
    )
    result.current.onMouseUp(mouseEvent('mouse', 2) as unknown as React.MouseEvent<HTMLElement>)
    expect(sendInput).toHaveBeenCalledWith({
      windowId: 1,
      pid: 42,
      input: { kind: 'click', x: 10, y: 20, button: 'left', clickCount: 2 }
    })
  })
})
