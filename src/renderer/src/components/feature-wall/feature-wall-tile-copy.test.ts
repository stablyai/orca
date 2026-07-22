import { beforeEach, describe, expect, it } from 'vitest'
import { i18n, setRendererUiLanguage } from '@/i18n/i18n'
import { UI_LANGUAGE_ENGLISH, UI_LANGUAGE_SPANISH } from '../../../../shared/ui-language'
import { FEATURE_WALL_TILES } from '../../../../shared/feature-wall-tiles'
import {
  getLocalizedFeatureWallMediaTile,
  getLocalizedFeatureWallTiles
} from './feature-wall-tile-copy'

describe('feature-wall-tile-copy', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en')
  })

  it('returns the English fallback title matching the raw shared data by default', () => {
    const localized = getLocalizedFeatureWallTiles()
    expect(localized.map((tile) => tile.id)).toEqual(FEATURE_WALL_TILES.map((tile) => tile.id))
    localized.forEach((tile, index) => {
      expect(tile.title).toBe(FEATURE_WALL_TILES[index].title)
    })
  })

  it('leaves non-copy fields such as caption untouched', () => {
    const tile01 = getLocalizedFeatureWallTiles().find((tile) => tile.id === 'tile-01')
    const rawTile01 = FEATURE_WALL_TILES.find((tile) => tile.id === 'tile-01')
    expect(tile01?.caption).toBe(rawTile01?.caption)
  })

  it('looks up a single localized media tile by id', () => {
    const tile = getLocalizedFeatureWallMediaTile('tile-04')
    const rawTile = FEATURE_WALL_TILES.find((candidate) => candidate.id === 'tile-04')
    expect(tile?.title).toBe(rawTile?.title)
    expect(getLocalizedFeatureWallMediaTile('tile-99' as never)).toBeNull()
  })

  it('does not throw when switching UI language, and keeps the same tile ids', async () => {
    await setRendererUiLanguage(UI_LANGUAGE_SPANISH)
    expect(() => getLocalizedFeatureWallTiles()).not.toThrow()
    expect(getLocalizedFeatureWallTiles().map((tile) => tile.id)).toEqual(
      FEATURE_WALL_TILES.map((tile) => tile.id)
    )
    await setRendererUiLanguage(UI_LANGUAGE_ENGLISH)
  })
})
