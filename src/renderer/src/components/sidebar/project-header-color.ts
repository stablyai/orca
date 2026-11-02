import { DEFAULT_REPO_BADGE_COLOR, REPO_COLORS } from '../../../../shared/constants'
import { normalizeRepoBadgeColor } from '../../../../shared/repo-badge-color'

const PROJECT_GROUP_HEADER_KEY_PREFIX = 'repo:'
const PROVIDER_PROJECT_HEADER_KEY_PREFIX = 'project:'

export function resolveRepoHeaderColor(badgeColor: string | null | undefined): string {
  const normalizedBadgeColor = normalizeRepoBadgeColor(badgeColor)
  if (!normalizedBadgeColor) {
    return DEFAULT_REPO_BADGE_COLOR
  }

  // Normalize persisted values before using them as inline CSS colors.
  return REPO_COLORS.find((repoColor) => repoColor === normalizedBadgeColor) ?? normalizedBadgeColor
}

export function resolveProjectGroupHeaderColor(args: {
  groupBy: string
  headerKey: string
  badgeColor: string | null | undefined
}): string | undefined {
  // Pinned and folder headers must not inherit project colors just because grouping is by repo.
  if (
    args.groupBy !== 'repo' ||
    (!args.headerKey.startsWith(PROJECT_GROUP_HEADER_KEY_PREFIX) &&
      !args.headerKey.startsWith(PROVIDER_PROJECT_HEADER_KEY_PREFIX))
  ) {
    return undefined
  }
  return resolveRepoHeaderColor(args.badgeColor)
}
