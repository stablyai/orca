import {
  FEATURE_WALL_TILES,
  isFeatureWallMediaTile,
  type FeatureWallMediaTile,
  type FeatureWallMediaTileId,
  type FeatureWallTile
} from '../../../../shared/feature-wall-tiles'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'
import { translate } from '@/i18n/i18n'

function localizeTile<T extends FeatureWallTile>(tile: T): T {
  return { ...tile, title: translate(`featureWallTiles.${tile.id}.title`, tile.title) }
}

export const getLocalizedFeatureWallTiles = createLocalizedCatalog(
  (): readonly FeatureWallTile[] => FEATURE_WALL_TILES.map(localizeTile)
)

const localizedMediaTileById = createLocalizedCatalog(
  (): ReadonlyMap<FeatureWallMediaTileId, FeatureWallMediaTile> =>
    new Map(
      getLocalizedFeatureWallTiles()
        .filter(isFeatureWallMediaTile)
        .map((tile) => [tile.id, tile])
    )
)

export function getLocalizedFeatureWallMediaTile(
  id: FeatureWallMediaTileId
): FeatureWallMediaTile | null {
  return localizedMediaTileById().get(id) ?? null
}
