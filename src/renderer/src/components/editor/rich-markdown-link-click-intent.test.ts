import { describe, expect, it } from 'vitest'
import { getRichMarkdownLinkClickIntent } from './rich-markdown-link-click-intent'

type ClickModifiers = {
  button: number
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
}

const plainClick: ClickModifiers = {
  button: 0,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false
}

describe('getRichMarkdownLinkClickIntent', () => {
  it('keeps plain clicks in selection mode by default', () => {
    expect(getRichMarkdownLinkClickIntent(plainClick, false, false)).toBe('select')
  })

  it('activates plain clicks while Follow links is enabled', () => {
    expect(getRichMarkdownLinkClickIntent(plainClick, false, true)).toBe('activate')
  })

  it('uses Cmd on macOS and Ctrl on Linux and Windows', () => {
    expect(getRichMarkdownLinkClickIntent({ ...plainClick, metaKey: true }, true, false)).toBe(
      'activate'
    )
    expect(getRichMarkdownLinkClickIntent({ ...plainClick, ctrlKey: true }, true, false)).toBe(
      'select'
    )
    expect(getRichMarkdownLinkClickIntent({ ...plainClick, ctrlKey: true }, false, false)).toBe(
      'activate'
    )
    expect(getRichMarkdownLinkClickIntent({ ...plainClick, metaKey: true }, false, false)).toBe(
      'select'
    )
  })

  it('uses the client-OS escape only with Shift and the platform modifier', () => {
    expect(
      getRichMarkdownLinkClickIntent({ ...plainClick, metaKey: true, shiftKey: true }, true, false)
    ).toBe('open-in-client-os')
    expect(
      getRichMarkdownLinkClickIntent({ ...plainClick, ctrlKey: true, shiftKey: true }, false, false)
    ).toBe('open-in-client-os')
    expect(getRichMarkdownLinkClickIntent({ ...plainClick, shiftKey: true }, false, false)).toBe(
      'select'
    )
  })

  it('treats Shift-click as normal activation when Follow links is enabled', () => {
    expect(getRichMarkdownLinkClickIntent({ ...plainClick, shiftKey: true }, false, true)).toBe(
      'activate'
    )
  })

  it('does not turn a non-primary plain click into Follow links navigation', () => {
    expect(getRichMarkdownLinkClickIntent({ ...plainClick, button: 1 }, false, true)).toBe('select')
  })
})
