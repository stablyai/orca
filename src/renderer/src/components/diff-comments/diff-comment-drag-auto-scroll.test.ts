import { describe, expect, it } from 'vitest'
import { getDragAutoScrollStepPx } from './diff-comment-drag-auto-scroll'

const EDITOR = { editorTop: 100, editorBottom: 500 }
const ONE_FRAME_MS = 1000 / 60

function stepAt(clientY: number, frameDeltaMs = ONE_FRAME_MS): number {
  return getDragAutoScrollStepPx({ ...EDITOR, clientY, frameDeltaMs })
}

describe('getDragAutoScrollStepPx', () => {
  it('covers the same distance per millisecond at any refresh rate', () => {
    expect(stepAt(600, ONE_FRAME_MS / 2) * 2).toBeCloseTo(stepAt(600, ONE_FRAME_MS), 8)
  })

  it('clamps the step a backgrounded window would otherwise resume with', () => {
    expect(stepAt(600, 5_000)).toBe(stepAt(600, 50))
  })
})
