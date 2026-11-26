// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createAgentCursor } from './agent-cursor-motion'

let now = 0
let frames: FrameRequestCallback[] = []

beforeEach(() => {
  now = 0
  frames = []
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.push(callback)
    return frames.length
  })
  vi.stubGlobal('cancelAnimationFrame', () => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function advanceFrames(count: number): void {
  for (let i = 0; i < count; i += 1) {
    now += 16
    const due = frames
    frames = []
    for (const callback of due) {
      callback(now)
    }
  }
}

function cursorAt(start: { x: number; y: number }) {
  const layer = document.createElement('div')
  document.body.appendChild(layer)
  const cursor = createAgentCursor(layer, { onArrived: () => {}, reducedMotion: () => false })
  cursor.moveTo(start, 1)
  return {
    layer,
    cursor,
    transform: () => layer.querySelector<HTMLElement>('.browser-agent-cursor')!.style.transform
  }
}

it('keeps gliding when the press echoed after a move repeats the same target', () => {
  const echoed = cursorAt({ x: 10, y: 10 })
  const plain = cursorAt({ x: 10, y: 10 })
  advanceFrames(40)
  const target = { x: 600, y: 420 }
  echoed.cursor.moveTo(target, 2)
  plain.cursor.moveTo(target, 2)
  advanceFrames(3)

  // An `orca tab cdp` click: its press reaches the overlay while the move is still gliding.
  echoed.cursor.moveTo(target, 3)
  echoed.cursor.press()
  for (let i = 0; i < 20; i += 1) {
    advanceFrames(1)
    expect(echoed.transform()).toBe(plain.transform())
  }

  const ring = echoed.layer.querySelector<HTMLElement>('.browser-agent-cursor-ring')
  expect(ring?.style.transform).toBe('translate3d(600px, 420px, 0)')
})
