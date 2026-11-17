import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'

/** Fence the Electron child to the CLI-resolved profile, preventing acquisition or messaging of another profile’s lock. */
export const SERVE_USER_DATA_PATH_ENV = 'ORCA_SERVE_USER_DATA_PATH'

function canonicalUserDataPath(path: string, platform: NodeJS.Platform): string {
  let canonical = resolve(path)
  try {
    // Why: /tmp vs /private/tmp style aliases must not read as two profiles.
    canonical = realpathSync.native(canonical)
  } catch {
    // Not created yet; the resolved spelling is all there is to compare.
  }
  return platform === 'win32' ? canonical.toLowerCase() : canonical
}

export function isSameUserDataPath(
  left: string,
  right: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  return canonicalUserDataPath(left, platform) === canonicalUserDataPath(right, platform)
}
