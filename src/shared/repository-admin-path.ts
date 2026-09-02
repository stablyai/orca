export type RepositoryAdminPathFlavour = 'posix' | 'win32'

export const REPOSITORY_ADMIN_PATH_DENIED_MESSAGE =
  'Access denied: Git repository metadata (.git) cannot be created, modified, moved, or deleted through the file explorer.'

const REPOSITORY_ADMIN_SEGMENT = '.git'

/**
 * Whether the path is, or is inside, Git repository admin state: `.git` as a directory, `.git` as
 * the `gitdir:` pointer file used by linked worktrees and submodules, or any descendant of either.
 *
 * Matches whole path segments, so `.github`, `.gitignore`, `.gitattributes`, `.gitmodules`,
 * `.gitkeep`, a file named `git` and a directory named `mygit` all stay mutable.
 *
 * Fails closed: a path that cannot be classified is treated as admin state.
 */
export function isRepositoryAdminPath(
  path: unknown,
  flavour: RepositoryAdminPathFlavour = 'posix'
): boolean {
  if (typeof path !== 'string' || path.trim() === '') {
    return true
  }
  // Both separators always: the runtime already folds `\` to `/` on every platform before joining.
  return path.split(/[\\/]+/).some((segment) => isRepositoryAdminSegment(segment, flavour))
}

function isRepositoryAdminSegment(segment: string, flavour: RepositoryAdminPathFlavour): boolean {
  // Win32 canonicalization drops trailing dots and spaces, so `.git.` and `.git ` open the real directory.
  const candidate = flavour === 'win32' ? segment.replace(/[. ]+$/, '') : segment
  // Case-folded unconditionally: APFS and NTFS resolve `.GIT` and `.Git` to the same directory.
  return candidate.toLowerCase() === REPOSITORY_ADMIN_SEGMENT
}
