import { describe, expect, it } from 'vitest'

import type { OrcaBackgroundSettings } from '../../../shared/orca-background-settings'
import {
  APPEARANCE_BACKGROUND_BLUR_PX_RANGE,
  APPEARANCE_BACKGROUND_OPACITY_RANGE,
  getAppearanceBackgroundDomArea,
  resolveAppearanceBackground
} from './appearance-background-settings'

function settingsWith(
  overrides: Partial<OrcaBackgroundSettings> = {}
): Partial<OrcaBackgroundSettings> {
  return overrides
}

describe('appearance background settings', () => {
  it('publishes the effect bounds used by resolution and controls', () => {
    expect(APPEARANCE_BACKGROUND_OPACITY_RANGE).toEqual({ min: 0, max: 1 })
    expect(APPEARANCE_BACKGROUND_BLUR_PX_RANGE).toEqual({ min: 0, max: 40 })
  })

  it('resolves independent images and preserves the legacy shared fallback', () => {
    const settings = settingsWith({
      orcaBackgroundImage: 'legacy.png',
      orcaBackgroundByArea: {
        terminal: 'terminal.png',
        leftSidebar: null,
        rightSidebar: 'right.png'
      },
      orcaBackgroundAreas: { terminal: true, leftSidebar: true, rightSidebar: true }
    })

    expect(resolveAppearanceBackground(settings, 'terminal').imageName).toBe('terminal.png')
    expect(resolveAppearanceBackground(settings, 'leftSidebar').imageName).toBeNull()
    expect(resolveAppearanceBackground(settings, 'rightSidebar').imageName).toBe('right.png')
    expect(
      resolveAppearanceBackground(
        settingsWith({ orcaBackgroundImage: 'legacy.png' }),
        'rightSidebar'
      ).imageName
    ).toBe('legacy.png')
  })

  it('uses safe area defaults when older settings omit the new maps', () => {
    const settings = settingsWith({ orcaBackgroundImage: 'legacy.png' })

    expect(resolveAppearanceBackground(settings, 'terminal').active).toBe(true)
    expect(resolveAppearanceBackground(settings, 'leftSidebar').active).toBe(false)
    expect(resolveAppearanceBackground(settings, 'rightSidebar').active).toBe(false)
  })

  it('clamps independent effects and rejects inherited fit names', () => {
    const settings = settingsWith({
      orcaBackgroundImage: 'image.png',
      orcaBackgroundOpacity: 0.4,
      orcaBackgroundOpacityByArea: { terminal: 2, leftSidebar: 0 },
      orcaBackgroundBlur: 5,
      orcaBackgroundBlurByArea: { terminal: -2, rightSidebar: 50 },
      orcaBackgroundFit: 'toString' as never
    })

    expect(resolveAppearanceBackground(settings, 'terminal')).toMatchObject({
      opacity: 1,
      blurPx: 0,
      fit: 'cover'
    })
    expect(resolveAppearanceBackground(settings, 'leftSidebar')).toMatchObject({
      opacity: 0,
      blurPx: 5
    })
    expect(resolveAppearanceBackground(settings, 'rightSidebar')).toMatchObject({
      opacity: 0.4,
      blurPx: 40
    })
  })

  it('maps setting area names to stable DOM tokens', () => {
    expect(getAppearanceBackgroundDomArea('terminal')).toBe('terminal')
    expect(getAppearanceBackgroundDomArea('leftSidebar')).toBe('left-sidebar')
    expect(getAppearanceBackgroundDomArea('rightSidebar')).toBe('right-sidebar')
  })
})
