import { realpathSync } from 'node:fs'

/** The path with symlinks resolved, or null when it doesn't exist or can't be read. */
export function resolveRealPathSync(path: string): string | null {
  try {
    return realpathSync.native(path)
  } catch {
    try {
      return realpathSync(path)
    } catch {
      return null
    }
  }
}
