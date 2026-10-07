import type { RepoIcon } from './repo-icon'

/** Client-local fallback icon shown for projects that carry no icon of their own. */
export type DefaultProjectIconPreferences = {
  defaultProjectIcon?: RepoIcon | null
  defaultProjectIconColor?: string
}

/**
 * Whether a project would show the global default. An absent icon and an auto-detected GitHub owner
 * avatar are both stand-ins Orca picked, so the default replaces them; every other icon — emoji,
 * lucide, upload, favicon, a repo-provided logo — was chosen for that project and wins.
 */
export function usesDefaultProjectIcon(repoIcon: RepoIcon | null | undefined): boolean {
  return !repoIcon || (repoIcon.type === 'image' && repoIcon.source === 'github')
}

/**
 * Resolve what a project surface should draw. Display-time only: the project's stored `repoIcon` is
 * never rewritten, so turning the preference off restores every previous icon.
 */
export function resolveProjectIconDisplay(
  repoIcon: RepoIcon | null | undefined,
  color: string | null | undefined,
  preferences: DefaultProjectIconPreferences | null | undefined
): { repoIcon: RepoIcon | null | undefined; color: string | null | undefined } {
  const fallback = preferences?.defaultProjectIcon
  if (!fallback || !usesDefaultProjectIcon(repoIcon)) {
    return { repoIcon, color }
  }
  return { repoIcon: fallback, color: preferences?.defaultProjectIconColor ?? color }
}
