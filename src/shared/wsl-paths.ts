export type WslUncPathInfo = {
  distro: string
  linuxPath: string
}

export function parseWslUncPath(path: string): WslUncPathInfo | null {
  const normalized = path.replace(/\\/g, '/')
  const match = normalized.match(/^\/\/(wsl\.localhost|wsl\$)\/([^/]+)(\/.*)?$/i)
  if (!match) {
    return null
  }

  return {
    distro: match[2],
    linuxPath: match[3] || '/'
  }
}

export function isWslUncPath(path: string): boolean {
  return parseWslUncPath(path) !== null
}

/**
 * Convert a Windows path to a Linux path for commands that will execute inside WSL.
 * Returns the path unchanged if it is already POSIX-style.
 *
 * Why: WSL hook/setup environments may need both the worktree UNC path
 * (\\wsl.localhost\...) and regular Windows install paths (C:\Users\...)
 * translated before passing them to bash. Leaving drive paths untouched
 * breaks scripts that read ORCA_ROOT_PATH or similar env vars inside WSL.
 */
export function toLinuxPath(windowsPath: string): string {
  // Why the platform guard: on a POSIX host a literal `//wsl$/x` path is an
  // ordinary directory, not a distro mount, so it must survive unchanged.
  const info = process.platform === 'win32' ? parseWslUncPath(windowsPath) : null
  if (info) {
    return info.linuxPath
  }

  const driveMatch = windowsPath.match(/^([A-Za-z]):[/\\](.*)$/)
  if (!driveMatch) {
    return windowsPath
  }

  const driveLetter = driveMatch[1].toLowerCase()
  const rest = driveMatch[2].replace(/\\/g, '/')
  return `/mnt/${driveLetter}/${rest}`
}

/** Convert an absolute Linux path in a known WSL distro to its Windows form. */
export function toWindowsWslPath(linuxPath: string, distro: string): string {
  const mntMatch = linuxPath.match(/^\/mnt\/([a-z])(\/.*)?$/)
  if (mntMatch) {
    const rest = (mntMatch[2] || '').replace(/\//g, '\\')
    return `${mntMatch[1].toUpperCase()}:${rest || '\\'}`
  }

  return `\\\\wsl.localhost\\${distro}${linuxPath.replace(/\//g, '\\')}`
}

/**
 * Resolve a repo-scoped worktree base path against the repo's own WSL distro.
 *
 * Why: project setup stores the value verbatim, and for a WSL-backed repo an
 * absolute Linux path like /home/user/trees is the natural spelling of a
 * location inside that distro. Windows path code reads it as drive-relative,
 * so the WSL workspace-mirroring heuristic silently replaced it with
 * ~/orca/workspaces (STA-4772). The repo path pins the distro, making the
 * value unambiguous — translate it to its UNC form. Non-WSL repos and
 * non-POSIX values (UNC, drive, relative) pass through untouched, so native
 * Windows, macOS/Linux, and SSH base paths keep their meaning.
 *
 * Why not toWindowsWslPath: its /mnt/<drive> branch emits a drive-letter path,
 * which the workspace-mirroring heuristic reads as desktop-local and discards —
 * the very bug this resolves. drvfs bases stay on the distro UNC view instead,
 * deliberately trading Windows-side throughput for a distro-addressable path
 * that keeps terminals inside WSL. The single-leading-slash guard is also
 * deliberate: multi-slash (//x) and backslash-rooted spellings are ambiguous
 * with Windows UNC and drive-relative forms and keep their old behavior.
 * Dot segments collapse here because ownership layouts compare paths without
 * resolving them, so creation and classification must see the same spelling.
 */
export function resolveWslRepoWorktreeBasePath(repoPath: string, basePath: string): string {
  const repoWsl = parseWslUncPath(repoPath)
  if (!repoWsl || !/^\/(?!\/)/.test(basePath)) {
    return basePath
  }
  const collapsed = collapsePosixDotSegments(basePath)
  return `\\\\wsl.localhost\\${repoWsl.distro}${collapsed === '/' ? '\\' : collapsed.replace(/\//g, '\\')}`
}

function collapsePosixDotSegments(absolutePosixPath: string): string {
  const segments: string[] = []
  for (const segment of absolutePosixPath.split('/')) {
    if (!segment || segment === '.') {
      continue
    }
    if (segment === '..') {
      segments.pop()
      continue
    }
    segments.push(segment)
  }
  return `/${segments.join('/')}`
}

// Why: Windows folds the share (\\wsl$ aliases \\wsl.localhost), the distro, and
// drvfs /mnt/<drive> tails case-insensitively; the rest of the Linux path is not.
export function foldWslUncPathCaseInsensitiveParts(path: string): string | null {
  const parsed = parseWslUncPath(path)
  if (!parsed) {
    return null
  }
  // Why: the drvfs automount is literally lowercase /mnt — a case-variant like
  // /MNT is an ordinary case-sensitive Linux dir and must not be folded.
  const linuxPath = /^\/mnt\/[a-zA-Z](?:\/|$)/.test(parsed.linuxPath)
    ? parsed.linuxPath.toLowerCase()
    : parsed.linuxPath
  return `//wsl.localhost/${parsed.distro.toLowerCase()}${linuxPath === '/' ? '' : linuxPath}`
}
