import { describe, expect, it } from 'vitest'
import {
  isSourceControlSplitOpenModifier,
  shouldOpenSourceControlRowAsPreview,
  toPermanentSourceControlRowOpenEvent,
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

describe('shouldOpenSourceControlRowAsPreview', () => {
  it('uses preview for plain row opens in the current group', () => {
    expect(shouldOpenSourceControlRowAsPreview(event(), undefined)).toBe(true)
  })

  it('does not preview when opening into a split group', () => {
    expect(shouldOpenSourceControlRowAsPreview(event(), 'group-2')).toBe(false)
  })

  it('does not preview when the row requests a permanent open', () => {
    expect(shouldOpenSourceControlRowAsPreview(event({ openAsPermanent: true }), undefined)).toBe(
      false
    )
  })
})

describe('toPermanentSourceControlRowOpenEvent', () => {
  it('preserves modifier keys and marks the row open as permanent', () => {
    expect(
      toPermanentSourceControlRowOpenEvent(
        event({
          altKey: true,
          metaKey: true
        })
      )
    ).toEqual({
      altKey: true,
      ctrlKey: false,
      metaKey: true,
      shiftKey: false,
      openAsPermanent: true
    })
  })
})
