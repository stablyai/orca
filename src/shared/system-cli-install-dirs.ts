import { join } from 'node:path'

/**
 * Where an agent CLI lands when no version manager installed it: Homebrew (both
 * prefixes), npm's default global prefix, snap, nix, or the CLI's own installer
 * (#829 named `~/.opencode/bin` and `~/.vite-plus/bin` as the motivating cases,
 * but only for the login-shell probe; the fallback used when that probe fails
 * never gained either).
 *
 * Ordered to match the system block `patchPackagedProcessPath` appends to PATH,
 * so a CLI present in two of *these* dirs resolves to the same binary here, in
 * the packaged PATH scan, and in `POSIX_VERSION_MANAGER_BIN_DIRS`. That parity
 * stops at the block boundary and is not claimed across it: the seed appends
 * `~/.local/bin` after this block, while here it arrives ahead of it from
 * `getBaseVersionManagerDirectories`, so a `claude` installed in both
 * `~/.local/bin` and `/opt/homebrew/bin` resolves to the former via this
 * fallback and the latter via the seeded PATH. Pre-existing, and left alone
 * because closing it means hoisting a system dir over a version-manager one.
 *
 * Deliberate gaps vs that seed: the `sbin` dirs, the generic `~/bin`, and
 * `/opt/homebrew` off darwin -- the seed does push that prefix on every posix,
 * but Linux Homebrew installs to the Linuxbrew prefix below, so off darwin it
 * is a directory no brew install can occupy.
 *
 * Lookup-only, deliberately outside `getBaseVersionManagerDirectories`: that
 * list is PREPENDED to PATH by `getVersionManagerBinPaths` callers, and hoisting
 * a system dir over the inherited PATH re-ranks binaries the user already has
 * (#18234). One bounded exception: when a hit here ships a sibling `node`,
 * `withCliRuntimeOnPath` prepends that dir onto the *spawned child's* PATH
 * (#10932 runtime pairing) -- only for a command PATH did not contain at all.
 */
export function getSystemCliInstallDirectories(
  platform: NodeJS.Platform,
  homePath: string
): string[] {
  // Why nothing here: the PATH seed's system block is POSIX-only too, so
  // Windows installs outside a version manager (`%USERPROFILE%\.opencode\bin`)
  // have never had install-dir coverage in either list. Unchanged, not fixed.
  if (platform === 'win32') {
    return []
  }
  const directories: string[] = []
  if (platform === 'darwin') {
    // Apple Silicon Homebrew; Intel Homebrew shares /usr/local with npm's prefix.
    directories.push('/opt/homebrew/bin')
  }
  directories.push('/usr/local/bin')
  if (platform === 'linux') {
    // Gated like the seed: snap and Linuxbrew ship on Linux only, so elsewhere they are phantom stats.
    directories.push('/snap/bin', '/home/linuxbrew/.linuxbrew/bin')
  }
  directories.push(
    '/nix/var/nix/profiles/default/bin',
    join(homePath, '.nix-profile', 'bin'),
    // Why both: the opencode and Pi installers' own defaults, which no version manager owns (#829).
    join(homePath, '.opencode', 'bin'),
    join(homePath, '.vite-plus', 'bin')
  )
  return directories
}
