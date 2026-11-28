import { realpathSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
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
  return platformPathKey(canonical, platform)
}

export function isSameUserDataPath(
  left: string,
  right: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  return canonicalUserDataPath(left, platform) === canonicalUserDataPath(right, platform)
}

function platformPathKey(path: string, platform: NodeJS.Platform): string {
  return platform === 'win32' ? path.toLowerCase() : path
}

/** Canonical profile comparison for event handlers that cannot block on the filesystem. */
export async function isSameUserDataPathAsync(
  left: string,
  right: string,
  platform: NodeJS.Platform = process.platform
): Promise<boolean> {
  const canonical = async (path: string): Promise<string> => {
    const resolved = resolve(path)
    return platformPathKey(await realpath(resolved).catch(() => resolved), platform)
  }
  const [a, b] = await Promise.all([canonical(left), canonical(right)])
  return a === b
}
