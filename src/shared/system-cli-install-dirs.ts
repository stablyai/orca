import { join } from 'node:path'

/** Lookup-only fallback: prepending system dirs to inherited PATH would reorder the user’s binaries (#18234).
 * Keep system-block order aligned with patchPackagedProcessPath/POSIX_VERSION_MANAGER_BIN_DIRS; cross-block precedence differs
 * for ~/.local/bin, which precedes this fallback but follows seeded system dirs. Do not hoist system paths above version managers.
 * Omit sbin/~/bin and off-darwin /opt/homebrew; Linuxbrew has its own prefix. Include installer-owned .opencode/.vite-plus (#829) and .grok (#17590) bins.
 * Exception: a newly discovered CLI with sibling node may prepend that dir only to its child PATH for runtime pairing (#10932). */
export function getSystemCliInstallDirectories(
  platform: NodeJS.Platform,
  homePath: string
): string[] {
  // Both lookup and seeded system blocks cover POSIX only; Windows installer paths remain outside this fallback.
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
    // Avoid phantom snap/Linuxbrew probes off Linux, matching seeded PATH.
    directories.push('/snap/bin', '/home/linuxbrew/.linuxbrew/bin')
  }
  directories.push(
    '/nix/var/nix/profiles/default/bin',
    join(homePath, '.nix-profile', 'bin'),
    join(homePath, '.opencode', 'bin'),
    join(homePath, '.vite-plus', 'bin'),
    join(homePath, '.grok', 'bin')
  )
  return directories
}
