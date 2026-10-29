import { DEFAULT_REPO_BADGE_COLOR, REPO_COLORS } from '../../../../shared/constants'
import { normalizeRepoBadgeColor } from '../../../../shared/repo-badge-color'

export function resolveRepoHeaderColor(badgeColor: string | null | undefined): string {
  const normalizedBadgeColor = normalizeRepoBadgeColor(badgeColor)
  if (!normalizedBadgeColor) {
    return DEFAULT_REPO_BADGE_COLOR
  }

  // Normalize persisted values before using them as inline CSS colors.
  return REPO_COLORS.find((repoColor) => repoColor === normalizedBadgeColor) ?? normalizedBadgeColor
}

export function resolveProjectGroupHeaderColor(args: {
  isProjectHeader: boolean
  badgeColor: string | null | undefined
}): string | undefined {
  // Header keys can contain provider-owned slashes and nested group segments.
  // The row model already knows the exact kind, so do not infer it from text.
  return args.isProjectHeader ? resolveRepoHeaderColor(args.badgeColor) : undefined
}
