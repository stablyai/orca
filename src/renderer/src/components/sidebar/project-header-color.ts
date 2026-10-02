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
  // Provider project IDs can contain slashes, so find an explicit project segment.
  const directProjectHeader =
    args.headerKey.startsWith(PROJECT_GROUP_HEADER_KEY_PREFIX) ||
    args.headerKey.startsWith(PROVIDER_PROJECT_HEADER_KEY_PREFIX)
  const nestedRepoIndex = args.headerKey.indexOf(`/${PROJECT_GROUP_HEADER_KEY_PREFIX}`)
  const nestedProjectIndex = args.headerKey.indexOf(`/${PROVIDER_PROJECT_HEADER_KEY_PREFIX}`)
  const projectHeader = directProjectHeader || nestedRepoIndex !== -1 || nestedProjectIndex !== -1
  if (args.groupBy !== 'repo' || !projectHeader) {
    return undefined
  }
  return resolveRepoHeaderColor(args.badgeColor)
}
