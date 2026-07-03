import { DEFAULT_REPO_BADGE_COLOR, REPO_COLORS } from '../../../../shared/constants'
import { normalizeRepoBadgeColor } from '../../../../shared/repo-badge-color'

const PROJECT_GROUP_HEADER_KEY_PREFIX = 'repo:'
const PROVIDER_PROJECT_HEADER_KEY_PREFIX = 'project:'

export function resolveRepoHeaderColor(badgeColor: string | null | undefined): string {
  const normalizedBadgeColor = normalizeRepoBadgeColor(badgeColor)
  if (!normalizedBadgeColor) {
    return DEFAULT_REPO_BADGE_COLOR
  }

  // Why: persisted repo colors are rendered as inline CSS here, so only
  // normalized hex values from the palette or custom picker reach the sidebar.
  return REPO_COLORS.find((repoColor) => repoColor === normalizedBadgeColor) ?? normalizedBadgeColor
}

export function resolveProjectGroupHeaderColor(args: {
  groupBy: string
  headerKey: string
  badgeColor: string | null | undefined
}): string | undefined {
  // Why: pinned/project-folder headers can appear while grouped by repo; only
  // actual project headers should inherit user-authored project colors.
  if (
    args.groupBy !== 'repo' ||
    (!args.headerKey.startsWith(PROJECT_GROUP_HEADER_KEY_PREFIX) &&
      !args.headerKey.startsWith(PROVIDER_PROJECT_HEADER_KEY_PREFIX))
  ) {
    return undefined
  }
  return resolveRepoHeaderColor(args.badgeColor)
}
