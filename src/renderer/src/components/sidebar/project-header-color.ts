import { DEFAULT_REPO_BADGE_COLOR, REPO_COLORS } from '../../../../shared/constants'

const PROJECT_GROUP_HEADER_KEY_PREFIX = 'repo:'

export function resolveRepoHeaderColor(badgeColor: string | null | undefined): string {
  const normalizedBadgeColor = badgeColor?.trim().toLowerCase()
  if (!normalizedBadgeColor) {
    return DEFAULT_REPO_BADGE_COLOR
  }

  // Why: persisted repo colors are rendered as inline CSS here, so only the
  // documented palette should reach the sidebar.
  return (
    REPO_COLORS.find((repoColor) => repoColor === normalizedBadgeColor) ?? DEFAULT_REPO_BADGE_COLOR
  )
}

export function resolveProjectGroupHeaderColor(args: {
  groupBy: string
  headerKey: string
  badgeColor: string | null | undefined
}): string | undefined {
  // Why: pinned headers can appear while grouped by repo, but only repo:* headers
  // represent a repo folder whose user-authored badge color should be shown.
  if (args.groupBy !== 'repo' || !args.headerKey.startsWith(PROJECT_GROUP_HEADER_KEY_PREFIX)) {
    return undefined
  }
  return resolveRepoHeaderColor(args.badgeColor)
}
