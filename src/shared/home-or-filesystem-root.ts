import { normalizeRuntimePathForComparison } from './cross-platform-path'

/** Drive, UNC share, WSL distro or POSIX root, as `normalizeRuntimePathForComparison` spells it. */
const FILESYSTEM_ROOT_KEY = /^(?:\/|[a-z]:\/?|\/\/[^/]+(?:\/[^/]+)?)$/i

/**
 * Whether `folderPath` is a filesystem root, a home folder or a folder above one. Pre-trusting
 * one would trust a home for agents that let a trusted folder cover its subfolders.
 */
export function isTooBroadToPreTrust(
  folderPath: string,
  homePaths: readonly (string | null | undefined)[]
): boolean {
  const key = normalizeRuntimePathForComparison(folderPath)
  return (
    FILESYSTEM_ROOT_KEY.test(key) ||
    homePaths.some((home) => {
      const homeKey = home ? normalizeRuntimePathForComparison(home) : null
      return homeKey !== null && (homeKey === key || homeKey.startsWith(`${key}/`))
    })
  )
}
