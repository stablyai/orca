import { describe, expect, it } from 'vitest'
import {
  getLocalhostWorktreeCssColor,
  getLocalhostWorktreeHue
} from './localhost-worktree-color'

describe('localhost worktree color', () => {
  it('derives a stable hue on the 12-step wheel from the label', () => {
    const first = getLocalhostWorktreeHue('analytics')
    const second = getLocalhostWorktreeHue('analytics')

    expect(first).toBe(second)
    expect(first).toBeGreaterThanOrEqual(0)
    expect(first).toBeLessThan(360)
    expect(first % 30).toBe(0)
  })

  it('gives different labels different hues', () => {
    // Deterministic sanity check: these known labels land on distinct wheel slots.
    expect(getLocalhostWorktreeHue('analytics')).not.toBe(getLocalhostWorktreeHue('snapstudio-main'))
  })

  it('formats the css color from the same hue and fixed saturation/lightness', () => {
    expect(getLocalhostWorktreeCssColor('analytics')).toBe(
      `hsl(${getLocalhostWorktreeHue('analytics')} 68% 46%)`
    )
  })
})
