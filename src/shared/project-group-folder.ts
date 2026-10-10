import { isRuntimePathAbsolute } from './cross-platform-path'

export const PROJECT_GROUP_FOLDER_ERROR = 'Project group folder must be an absolute path'

/** User-visible root Orca already owns for worktrees; group folders sit beside them. */
export const MANAGED_PROJECT_GROUP_ROOT_DIRNAME = 'Orca'
export const MANAGED_PROJECT_GROUP_DIRNAME = 'groups'

/**
 * A group folder must be absolute. The runtime resolves it, and it may run with a
 * different working directory than the client that set it, so a relative path would
 * silently land somewhere else. A blank value is allowed: it clears the folder.
 */
export function isProjectGroupFolderValid(value: string | null | undefined): boolean {
  if (value === null || value === undefined) {
    return true
  }
  const trimmed = value.trim()
  return trimmed.length === 0 || isRuntimePathAbsolute(trimmed)
}

/** Filesystem-safe directory name for a group. */
export function projectGroupFolderSlug(name: string, id: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  // Why: two groups may share a display name, and their folders must not collide.
  return slug.length > 0 ? `${slug}-${id.slice(0, 8)}` : id
}

/**
 * Folder a new local group gets when the caller does not supply one, so a group is
 * never created without somewhere to work. Callers may still point it elsewhere later.
 */
export function resolveDefaultProjectGroupFolder(
  group: { id: string; name: string },
  managedRoot: string,
  separator = '/'
): string {
  const root = managedRoot.endsWith(separator) ? managedRoot.slice(0, -1) : managedRoot
  return [root, MANAGED_PROJECT_GROUP_DIRNAME, projectGroupFolderSlug(group.name, group.id)].join(
    separator
  )
}
