import { describe, expect, it } from 'vitest'
import {
  isTerminalTabSurfaceLaidOut,
  resolveTerminalTabSurfaceStyle
} from './terminal-tab-visibility-style'

describe('resolveTerminalTabSurfaceStyle', () => {
  it('keeps the active tab fully laid out', () => {
    expect(
      resolveTerminalTabSurfaceStyle({
        isVisible: true,
        isWorktreeActive: true,
        shouldMeasureHiddenStartup: false
      })
    ).toEqual({ display: 'flex' })
  })

  it('keeps layout with opacity when another tab in the same worktree is active', () => {
    const style = resolveTerminalTabSurfaceStyle({
      isVisible: false,
      isWorktreeActive: true,
      shouldMeasureHiddenStartup: false
    })
    expect(style).toEqual({ display: 'flex', opacity: 0, pointerEvents: 'none' })
    expect(isTerminalTabSurfaceLaidOut(style)).toBe(true)
  })

  it('keeps layout for hidden startup measurement', () => {
    expect(
      resolveTerminalTabSurfaceStyle({
        isVisible: false,
        isWorktreeActive: false,
        shouldMeasureHiddenStartup: true
      })
    ).toEqual({ display: 'flex', opacity: 0, pointerEvents: 'none' })
  })

  it('collapses only when the worktree surface itself is inactive', () => {
    const style = resolveTerminalTabSurfaceStyle({
      isVisible: false,
      isWorktreeActive: false,
      shouldMeasureHiddenStartup: false
    })
    expect(style).toEqual({ display: 'none', pointerEvents: 'none' })
    expect(isTerminalTabSurfaceLaidOut(style)).toBe(false)
  })
})