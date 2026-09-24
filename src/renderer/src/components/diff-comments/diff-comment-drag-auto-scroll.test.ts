import { describe, expect, it } from 'vitest'
import { getDragAutoScrollStepPx } from './diff-comment-drag-auto-scroll'

const EDITOR = { editorTop: 100, editorBottom: 500 }
const ONE_FRAME_MS = 1000 / 60

function stepAt(clientY: number, frameDeltaMs = ONE_FRAME_MS): number {
  return getDragAutoScrollStepPx({ ...EDITOR, clientY, frameDeltaMs })
}

describe('getDragAutoScrollStepPx', () => {
  it('stays still while the pointer is away from both edges', () => {
    expect(stepAt(300)).toBe(0)
    expect(stepAt(130)).toBe(0)
    expect(stepAt(470)).toBe(0)
  })

  it('pulls down past the bottom edge and up past the top edge', () => {
    expect(stepAt(490)).toBeGreaterThan(0)
    expect(stepAt(110)).toBeLessThan(0)
  })

  it('pulls harder the further past the edge the pointer is', () => {
    expect(stepAt(600)).toBeGreaterThan(stepAt(490))
  })

  it('caps the pull however far past the edge the pointer goes', () => {
    expect(stepAt(5000)).toBe(stepAt(100_000))
  })

  it('covers the same distance per millisecond at any refresh rate', () => {
    expect(stepAt(600, ONE_FRAME_MS / 2) * 2).toBeCloseTo(stepAt(600, ONE_FRAME_MS), 8)
  })

  it('clamps the step a backgrounded window would otherwise resume with', () => {
    expect(stepAt(600, 5_000)).toBe(stepAt(600, 50))
  })
})
