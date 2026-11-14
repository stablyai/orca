import { removeTree } from '../windows-transient-lock-removal'

/** Removes every directory even when one fails, then rethrows the first failure. */
export async function removeTempDirs(dirs: readonly string[]): Promise<void> {
  const results = await Promise.allSettled(dirs.map((dir) => removeTree(dir)))
  const failed = results.find((result) => result.status === 'rejected')
  if (failed) {
    throw failed.reason
  }
}
