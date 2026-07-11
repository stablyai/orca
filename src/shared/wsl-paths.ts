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

// Matches the legacy \\wsl$\ (or //wsl$/) share prefix, capturing the leading
// separator pair and the separator that follows the share name.
const WSL_LEGACY_UNC_PREFIX_RE = /^(\/\/|\\\\)wsl\$([/\\])/i

/**
 * Rewrite the legacy `\\wsl$\` share prefix to the modern `\\wsl.localhost\` form.
 *
 * Why: the WSL filesystem watcher only emits `\\wsl.localhost\` paths, so repos
 * added or persisted under the legacy prefix must canonicalize to this form to
 * dedup and compare equal against watcher-sourced paths.
 */
export function normalizeWslUncPrefix(path: string): string {
  return path.replace(WSL_LEGACY_UNC_PREFIX_RE, '$1wsl.localhost$2')
}
