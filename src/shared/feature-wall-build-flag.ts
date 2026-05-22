declare const ORCA_FEATURE_WALL_ENABLED: boolean | undefined

type FeatureWallBuildFlagGlobal = typeof globalThis & {
  ORCA_FEATURE_WALL_ENABLED?: boolean
}

export const FEATURE_WALL_ENABLED =
  typeof ORCA_FEATURE_WALL_ENABLED !== 'undefined'
    ? ORCA_FEATURE_WALL_ENABLED
    : ((globalThis as FeatureWallBuildFlagGlobal).ORCA_FEATURE_WALL_ENABLED ?? false)
