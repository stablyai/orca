// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const storeState = vi.hoisted(() => ({
  agentStatusByPaneKey: {},
  agentStatusEpoch: 0,
  retainedAgentsByPaneKey: {},
  petSize: 180
}))

const cpuSpeedMocks = vi.hoisted(() => ({
  useSpeed: vi.fn((_active: boolean) => 1.5)
}))

vi.mock('../../store', () => ({
  useAppStore: Object.assign(
    <T,>(selector: (state: typeof storeState) => T): T => selector(storeState),
    { getState: () => storeState }
  )
}))

vi.mock('@/hooks/usePrefersReducedMotion', () => ({
  usePrefersReducedMotion: () => false
}))

vi.mock('./pet-cpu-animation-speed', () => ({
  usePetCpuAnimationSpeed: (active: boolean) => cpuSpeedMocks.useSpeed(active),
  getPetFrameIntervalMs: (fps: number, speedMultiplier: number) => 1000 / (fps * speedMultiplier)
}))

vi.mock('./usePetUrl', () => ({
  usePetUrl: () => ({
    url: 'blob:detected-pet',
    ready: true,
    sprite: null,
    detected: {
      frames: [
        { x: 0, y: 0, w: 32, h: 32 },
        { x: 32, y: 0, w: 32, h: 32 }
      ],
      bitmaps: [{}, {}] as ImageBitmap[],
      fps: 8
    }
  })
}))

import { PetOverlay } from './PetOverlay'

describe('PetOverlay detected sprite CPU speed', () => {
  let root: Root | null = null
  let container: HTMLDivElement | null = null
  let rafCallbacks: FrameRequestCallback[] = []
  const drawImage = vi.fn()

  beforeEach(() => {
    rafCallbacks = []
    drawImage.mockClear()
    cpuSpeedMocks.useSpeed.mockClear()
    vi.spyOn(performance, 'now').mockReturnValue(0)
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((callback: FrameRequestCallback) => {
        rafCallbacks.push(callback)
        return rafCallbacks.length
      })
    )
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      clearRect: vi.fn(),
      drawImage,
      imageSmoothingEnabled: false
    } as unknown as CanvasRenderingContext2D)
  })

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    root = null
    container = null
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('detected sprite의 rAF threshold에 CPU 속도 배수를 적용한다', () => {
    // Given
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    // When
    act(() => root?.render(<PetOverlay />))

    // Then
    expect(cpuSpeedMocks.useSpeed).toHaveBeenCalledWith(true)
    expect(drawImage).toHaveBeenCalledTimes(1)

    // When: 8fps at 1.5x advances after 83.33ms, not before it.
    act(() => rafCallbacks.shift()?.(80))
    expect(drawImage).toHaveBeenCalledTimes(1)
    act(() => rafCallbacks.shift()?.(84))

    // Then
    expect(drawImage).toHaveBeenCalledTimes(2)
  })
})
