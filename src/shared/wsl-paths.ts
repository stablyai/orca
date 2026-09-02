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
  return toWindowsWslDrivePath(linuxPath) ?? toWindowsWslUncPath(linuxPath, distro)
}

/** Keep a Linux path addressable through its distro, including drvfs mounts. */
export function toWindowsWslUncPath(linuxPath: string, distro: string): string {
  return `\\\\wsl.localhost\\${distro}${linuxPath === '/' ? '\\' : linuxPath.replace(/\//g, '\\')}`
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
  return toWindowsWslUncPath(collapsed, repoWsl.distro)
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

/**
 * The spelling a WSL-hosted tool answers in for `path`. Git-in-the-distro resolves relative output
 * against the Linux path, not the caller's UNC spelling, and realpath cannot bridge the two spaces.
 */
export function toWslExecutionSpace(path: string): string {
  return parseWslUncPath(path)?.linuxPath ?? path
}

/**
 * The drvfs automount is literally lowercase `/mnt/<letter>`; `/MNT` is an ordinary Linux dir.
 * Deliberately looser than `toWindowsWslDrivePath`'s end-anchored matcher below: this one only
 * classifies a prefix, so do not unify them — the anchoring there is what keeps a path carrying a
 * stray line terminator off the drive spelling.
 */
const DRVFS_LINUX_PATH = /^\/mnt\/[a-z](?:\/|$)/

/** True for a Linux path that is really a Windows drive reached through drvfs. */
export function isDrvfsLinuxPath(linuxPath: string): boolean {
  return DRVFS_LINUX_PATH.test(linuxPath)
}

/**
 * The Windows drive spelling of a drvfs path, or null when the path is not one. Needs no distro:
 * the bytes sit on the drive whichever distro mounted them.
 */
export function toWindowsWslDrivePath(linuxPath: string): string | null {
  // `.` excludes every line terminator, so a drvfs prefix on a stray output line (an rg hit that
  // still carries its CR) stays off the drive spelling.
  const match = linuxPath.match(/^\/mnt\/([a-z])(\/.*)?$/)
  if (!match) {
    return null
  }
  const tail = (match[2] ?? '').replace(/\//g, '\\')
  return `${match[1].toUpperCase()}:${tail || '\\'}`
}

/**
 * The distro whose git would reach `projectPath` across the 9p/drvfs boundary, or null when it
 * would not.
 *
 * Two shapes cross it. A Windows drive path (`C:\...`) crosses it whenever the project's runtime is
 * WSL. The UNC spelling of a distro's own drvfs mount (`\\wsl.localhost\Ubuntu\mnt\c\...`) crosses
 * it however the runtime is set, because the bytes sit on the Windows drive either way.
 *
 * Everything else returns null: a real Linux path inside the distro, a drive path under Windows-host
 * git, a plain UNC share (not mounted in the distro at all), and any POSIX or SSH path.
 */
export function getWslFilesystemBoundaryDistro(args: {
  projectPath: string
  wslRuntimeDistro?: string | null
}): string | null {
  const wsl = parseWslUncPath(args.projectPath)
  if (wsl) {
    return isDrvfsLinuxPath(wsl.linuxPath) ? wsl.distro : null
  }
  if (!/^[A-Za-z]:[\\/]/.test(args.projectPath)) {
    return null
  }
  return args.wslRuntimeDistro || null
}
