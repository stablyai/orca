// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const wake = vi.hoisted(() => ({
  dragStart: vi.fn(),
  dragEnd: vi.fn(),
  hoverStart: vi.fn(),
  hoverEnd: vi.fn(),
  select: vi.fn()
}))

vi.mock('@/lib/orca-cloud/cloud-predictive-wake', () => ({
  notePredictiveWakeDragStart: wake.dragStart,
  notePredictiveWakeDragEnd: wake.dragEnd,
  notePredictiveWakeHoverStart: wake.hoverStart,
  notePredictiveWakeHoverEnd: wake.hoverEnd,
  notePredictiveWakeSelect: wake.select
}))
vi.mock('../../../terminal/terminal-worktree-prewarm', () => ({
  setTerminalPrewarmWorktrees: vi.fn()
}))

import { ROW_DRAG_SLOP_PX, noteWorktreeRowPress } from './worktree-row-hover-prewarm'

const pointer = (type: string, init: { x?: number; y?: number; buttons?: number } = {}) =>
  window.dispatchEvent(
    new MouseEvent(type, { clientX: init.x ?? 0, clientY: init.y ?? 0, buttons: init.buttons ?? 0 })
  )

describe('row press and drag intent', () => {
  beforeEach(() => {
    for (const fn of Object.values(wake)) {
      fn.mockClear()
    }
  })

  it('a press released in place wakes on the release, not the press', () => {
    noteWorktreeRowPress('ws-a', 100, 100)
    expect(wake.select).not.toHaveBeenCalled()
    pointer('pointermove', { x: 101, y: 101, buttons: 1 })
    pointer('pointerup', { x: 101, y: 101 })
    expect(wake.select).toHaveBeenCalledWith('ws-a')
    expect(wake.dragStart).not.toHaveBeenCalled()
  })

  it('a press that moves past the slop is a drag (any drag code): no wake, and it ends on release', () => {
    noteWorktreeRowPress('ws-a', 100, 100)
    pointer('pointermove', { x: 100, y: 100 + ROW_DRAG_SLOP_PX + 2, buttons: 1 })
    expect(wake.dragStart).toHaveBeenCalledTimes(1)
    pointer('pointermove', { x: 100, y: 180, buttons: 1 })
    expect(wake.dragStart).toHaveBeenCalledTimes(1)
    pointer('pointerup', { x: 100, y: 180 })
    expect(wake.dragEnd).toHaveBeenCalledTimes(1)
    expect(wake.select).not.toHaveBeenCalled()
  })

  it('a native drag whose end never reaches the window is cleared by the next buttonless move', () => {
    noteWorktreeRowPress('ws-a', 100, 100)
    window.dispatchEvent(new Event('dragstart'))
    pointer('pointercancel')
    expect(wake.dragStart).toHaveBeenCalledTimes(1)
    pointer('pointermove', { x: 300, y: 300, buttons: 0 })
    expect(wake.dragEnd).toHaveBeenCalledTimes(1)
    expect(wake.select).not.toHaveBeenCalled()
  })
})
