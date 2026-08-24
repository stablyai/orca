import { describe, expect, it } from 'vitest'
import {
  ORCA_BACKGROUND_AREAS,
  getDefaultOrcaBackgroundSettings,
  normalizeOrcaBackgroundSettings,
  normalizeOrcaBackgroundSettingsUpdate
} from './orca-background-settings'

describe('Orca background settings', () => {
  it('creates independent nested defaults', () => {
    const first = getDefaultOrcaBackgroundSettings()
    const second = getDefaultOrcaBackgroundSettings()

    first.orcaBackgroundAreas.terminal = false
    first.orcaBackgroundByArea.terminal = 'first.png'

    expect(second).toEqual({
      orcaBackgroundImage: null,
      orcaBackgroundByArea: {},
      orcaBackgroundOpacity: 0.35,
      orcaBackgroundOpacityByArea: {},
      orcaBackgroundBlur: 0,
      orcaBackgroundBlurByArea: {},
      orcaBackgroundFit: 'cover',
      orcaBackgroundAreas: {
        terminal: true,
        leftSidebar: false,
        rightSidebar: false
      }
    })
  })

  it('normalizes known areas, filenames, effects, and fit', () => {
    expect(
      normalizeOrcaBackgroundSettings({
        orcaBackgroundImage: '../legacy.png',
        orcaBackgroundByArea: {
          terminal: 'terminal.png',
          leftSidebar: null,
          rightSidebar: 'nested\\right.png',
          unknown: 'ignored.png'
        },
        orcaBackgroundOpacity: 2,
        orcaBackgroundOpacityByArea: {
          terminal: -1,
          leftSidebar: 0.6,
          rightSidebar: Number.NaN
        },
        orcaBackgroundBlur: -4,
        orcaBackgroundBlurByArea: {
          terminal: 60,
          leftSidebar: 8,
          rightSidebar: Number.POSITIVE_INFINITY
        },
        orcaBackgroundFit: 'unknown',
        orcaBackgroundAreas: {
          terminal: false,
          leftSidebar: true,
          rightSidebar: 'yes'
        }
      })
    ).toEqual({
      orcaBackgroundImage: null,
      orcaBackgroundByArea: {
        terminal: 'terminal.png',
        leftSidebar: null,
        rightSidebar: null
      },
      orcaBackgroundOpacity: 1,
      orcaBackgroundOpacityByArea: { terminal: 0, leftSidebar: 0.6 },
      orcaBackgroundBlur: 0,
      orcaBackgroundBlurByArea: { terminal: 40, leftSidebar: 8 },
      orcaBackgroundFit: 'cover',
      orcaBackgroundAreas: {
        terminal: false,
        leftSidebar: true,
        rightSidebar: false
      }
    })
  })

  it('normalizes every canonical enabled area', () => {
    const settings = normalizeOrcaBackgroundSettings({
      orcaBackgroundAreas: { terminal: false }
    })

    expect(Object.keys(settings.orcaBackgroundAreas)).toEqual([...ORCA_BACKGROUND_AREAS])
    expect(settings.orcaBackgroundAreas).toEqual({
      terminal: false,
      leftSidebar: false,
      rightSidebar: false
    })
  })

  it('normalizes only the keys present in an update', () => {
    const current = {
      ...getDefaultOrcaBackgroundSettings(),
      orcaBackgroundByArea: { terminal: 'terminal.png', leftSidebar: 'left.png' }
    }

    expect(
      normalizeOrcaBackgroundSettingsUpdate(
        {
          orcaBackgroundOpacityByArea: { terminal: 2, rightSidebar: 0.25 }
        },
        current
      )
    ).toEqual({
      orcaBackgroundOpacityByArea: { terminal: 1, rightSidebar: 0.25 }
    })
  })
})
