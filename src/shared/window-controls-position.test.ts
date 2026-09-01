import { describe, expect, it } from 'vitest'
import {
  DEFAULT_WINDOW_CONTROLS_POSITION,
  normalizeWindowControlsPosition,
  resolveWindowControlsSide
} from './window-controls-position'

describe('normalizeWindowControlsPosition', () => {
  it('keeps left and right', () => {
    expect(normalizeWindowControlsPosition('left')).toBe('left')
    expect(normalizeWindowControlsPosition('right')).toBe('right')
  })

  it('falls back to the default for unknown values', () => {
    expect(normalizeWindowControlsPosition(undefined)).toBe(DEFAULT_WINDOW_CONTROLS_POSITION)
    expect(normalizeWindowControlsPosition('system')).toBe(DEFAULT_WINDOW_CONTROLS_POSITION)
    expect(normalizeWindowControlsPosition(1)).toBe(DEFAULT_WINDOW_CONTROLS_POSITION)
  })
})

describe('resolveWindowControlsSide', () => {
  it('honors left only on Linux', () => {
    expect(resolveWindowControlsSide({ platform: 'linux', preference: 'left' })).toBe('left')
    expect(resolveWindowControlsSide({ platform: 'linux', preference: 'right' })).toBe('right')
  })

  it('keeps Windows and macOS on the right convention', () => {
    expect(resolveWindowControlsSide({ platform: 'win32', preference: 'left' })).toBe('right')
    expect(resolveWindowControlsSide({ platform: 'darwin', preference: 'left' })).toBe('right')
  })
})
