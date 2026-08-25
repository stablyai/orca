// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { browserOverlayOwnsShortcutTarget } from './browser-overlay-shortcut-target'

describe('browserOverlayOwnsShortcutTarget', () => {
  it('matches only overlay descendants tagged with the same tab id', () => {
    const overlay = document.createElement('div')
    overlay.setAttribute('data-browser-overlay-tab-id', 'tab-1')
    const child = document.createElement('button')
    overlay.appendChild(child)
    document.body.appendChild(overlay)

    expect(browserOverlayOwnsShortcutTarget(child, 'tab-1')).toBe(true)
    expect(browserOverlayOwnsShortcutTarget(child, 'tab-2')).toBe(false)
    expect(browserOverlayOwnsShortcutTarget(document.body, 'tab-1')).toBe(false)
    expect(browserOverlayOwnsShortcutTarget(null, 'tab-1')).toBe(false)
  })
})
