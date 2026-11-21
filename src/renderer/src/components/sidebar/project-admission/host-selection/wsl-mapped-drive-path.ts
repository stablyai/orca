const DRIVE_PATH = /^[A-Za-z]:(?:[\\/]|$)/

/**
 * The `\\wsl.localhost\<distro>\…` spelling of a path on a drive mapped to a distro share, so the
 * WSL host checks see it; null for any other path. Main resolves the mapping, bounded and cached.
 */
export async function resolveWslMappedDrivePath(path: string): Promise<string | null> {
  if (!DRIVE_PATH.test(path)) {
    return null
  }
  try {
    return (await window.api.wsl.resolveMappedDrivePath(path)) ?? null
  } catch {
    return null
  }
}
