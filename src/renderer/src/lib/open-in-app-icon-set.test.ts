import { describe, expect, it } from 'vitest'
import { OPEN_IN_APP_ICON_IDS } from '../../../shared/open-in-app-icons'
import { getOpenInAppIconGlyph, getOpenInAppIconOptions } from './open-in-app-icon-set'

describe('open-in app icon set', () => {
  it('gives every option a non-empty label', () => {
    for (const option of getOpenInAppIconOptions()) {
      expect(option.label.trim()).not.toBe('')
    }
  })

  it('maps each id to a distinct glyph', () => {
    const glyphs = new Set(OPEN_IN_APP_ICON_IDS.map((id) => getOpenInAppIconGlyph(id)))

    expect(glyphs.size).toBe(OPEN_IN_APP_ICON_IDS.length)
  })
})
