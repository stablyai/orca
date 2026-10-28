export type WslUncPathInfo = {
  distro: string
  linuxPath: string
}

const SLASH_CHAR_CODE = '/'.charCodeAt(0)
const BACKSLASH_CHAR_CODE = '\\'.charCodeAt(0)

function isPathSeparatorCharCode(charCode: number): boolean {
  return charCode === SLASH_CHAR_CODE || charCode === BACKSLASH_CHAR_CODE
}

export function parseWslUncPath(path: string): WslUncPathInfo | null {
  // Skip normalization/regex for non-UNC paths on the FS-event hot path.
  if (
    !isPathSeparatorCharCode(path.charCodeAt(0)) ||
    !isPathSeparatorCharCode(path.charCodeAt(1))
  ) {
    return null
  }
  const normalized = path.includes('\\') ? path.replace(/\\/g, '/') : path
  const match = normalized.match(/^\/\/(wsl\.localhost|wsl\$)\/([^/]+)(\/.*)?$/i)
  if (!match) {
    return null
  }

  return {
    distro: match[2],
    linuxPath: match[3] || '/'
  }
}

/** Linux form of `value` when it is a UNC path of `distro` (either spelling, either slash). */
export function wslUncPathToLinux(value: string, distro: string): string | null {
  const parsed = parseWslUncPath(value)
  // WSL resolves distro names case-insensitively, and so does every UNC path to one.
  return parsed && parsed.distro.toLowerCase() === distro.toLowerCase() ? parsed.linuxPath : null
}

export function isWslUncPath(path: string): boolean {
  return parseWslUncPath(path) !== null
}

/** Translate UNC and drive paths before passing hook/setup paths to WSL bash; leave POSIX paths unchanged. */
export function toLinuxPath(windowsPath: string): string {
  // A literal //wsl$/x on POSIX is an ordinary directory and must survive unchanged.
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

/** Resolve an absolute POSIX base within the repo’s WSL distro; Windows otherwise treats it as drive-relative and discards it (STA-4772). Other forms pass through.
 * Keep drvfs on the distro UNC view so mirroring retains WSL terminal routing. Preserve ambiguous multi-slash/backslash roots unchanged; collapse dot segments so creation and ownership classification agree. */
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

// Fold share aliases, distro and drvfs drive tails; ordinary Linux paths remain case-sensitive.
export function foldWslUncPathCaseInsensitiveParts(path: string): string | null {
  const parsed = parseWslUncPath(path)
  if (!parsed) {
    return null
  }
  // Only lowercase /mnt is drvfs; /MNT stays case-sensitive.
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

/** Classify the lowercase drvfs prefix only. Keep separate from toWindowsWslDrivePath’s whole-path validation, which rejects stray line terminators. */
const DRVFS_LINUX_PATH = /^\/mnt\/[a-z](?:\/|$)/

/** True for a Linux path that is really a Windows drive reached through drvfs. */
export function isDrvfsLinuxPath(linuxPath: string): boolean {
  return DRVFS_LINUX_PATH.test(linuxPath)
}

/** Drvfs bytes belong to a Windows drive regardless of which distro mounted it. */
export function toWindowsWslDrivePath(linuxPath: string): string | null {
  // Dot excludes line terminators, preventing stray CR/output lines from becoming drive paths.
  const match = linuxPath.match(/^\/mnt\/([a-z])(\/.*)?$/)
  if (!match) {
    return null
  }
  const tail = (match[2] ?? '').replace(/\//g, '\\')
  return `${match[1].toUpperCase()}:${tail || '\\'}`
}

/** Return the distro crossing the 9p/drvfs boundary: drive paths under WSL runtime, or UNC drvfs mounts regardless of runtime. Linux-native, ordinary UNC, POSIX and SSH paths do not cross. */
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

/** Queue dead-share subdirectories by host. Local disks need no lane because they do not block comparably. */
export function uncRouteKey(cwd: string): string | null {
  if (!cwd.startsWith('\\\\')) {
    return null
  }
  const wslInfo = parseWslUncPath(cwd)
  if (wslInfo) {
    return `wsl:${wslInfo.distro.trim().toLowerCase()}`
  }
  const server = cwd.slice(2).split(/[\\/]/, 1)[0]
  return `unc:${server.toLowerCase()}`
}
