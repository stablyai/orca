import { describe, expect, it } from 'vitest'
import {
  isSourceControlSplitOpenModifier,
  type SourceControlRowOpenEvent
} from './source-control-split-open'

function event(overrides: Partial<SourceControlRowOpenEvent> = {}): SourceControlRowOpenEvent {
  return {
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    ...overrides
  }
}

describe('isSourceControlSplitOpenModifier', () => {
  it('uses Cmd on macOS and Ctrl elsewhere as the platform primary modifier', () => {
    expect(isSourceControlSplitOpenModifier(event({ metaKey: true }), true)).toBe(true)
    expect(isSourceControlSplitOpenModifier(event({ ctrlKey: true }), true)).toBe(false)

    expect(isSourceControlSplitOpenModifier(event({ ctrlKey: true }), false)).toBe(true)
    expect(isSourceControlSplitOpenModifier(event({ metaKey: true }), false)).toBe(false)
  })

  it('treats Shift and Alt/Option as split-open modifiers', () => {
    expect(isSourceControlSplitOpenModifier(event({ shiftKey: true }), true)).toBe(true)
    expect(isSourceControlSplitOpenModifier(event({ altKey: true }), false)).toBe(true)
  })

  it('ignores a plain click', () => {
    expect(isSourceControlSplitOpenModifier(event(), true)).toBe(false)
    expect(isSourceControlSplitOpenModifier(event(), false)).toBe(false)
  })
})
