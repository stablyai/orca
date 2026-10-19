import {
  createNormalizedPathInsideOrEqualMatcher,
  normalizeRuntimePathForComparison
} from './cross-platform-path'
import { parseWslUncPath, toWindowsWslPath } from './wsl-paths'

/** Native scans can contain several WSL distros under the same execution host. */
export function sessionFileExecutionNamespace(filePath: string): string {
  const wslPath = parseWslUncPath(filePath)
  return wslPath ? `wsl:${wslPath.distro.toLowerCase()}` : 'native'
}

/** Shared membership for source admission, cached depth and displayed ownership. */
export function createAiVaultScopeCwdMatcher(
  scopePaths: readonly string[]
): (cwd: string | null | undefined, filePath?: string) => boolean {
  const matches = createNormalizedAiVaultScopeCwdMatcher(scopePaths)
  return (cwd, filePath) =>
    cwd ? matches(normalizeRuntimePathForComparison(cwd), filePath) : false
}

/** Pre-normalized variant for project attribution across many candidate roots. */
export function createNormalizedAiVaultScopeCwdMatcher(
  scopePaths: readonly string[]
): (normalizedCwd: string, filePath?: string) => boolean {
  const matchers = scopePaths.map((scopePath) => {
    const direct = createNormalizedPathInsideOrEqualMatcher(scopePath)
    const wsl = parseWslUncPath(scopePath)
    const linux = wsl && createNormalizedPathInsideOrEqualMatcher(wsl.linuxPath)
    const mounted =
      wsl && /^\/mnt\/[A-Za-z](?:\/|$)/.test(wsl.linuxPath)
        ? createNormalizedPathInsideOrEqualMatcher(toWindowsWslPath(wsl.linuxPath, wsl.distro))
        : null
    return { direct, wsl, linux, mounted }
  })
  return (cwd, filePath) => {
    if (!cwd || matchers.length === 0) {
      return false
    }
    const normalized = cwd
    const namespace = filePath ? sessionFileExecutionNamespace(filePath) : 'native'
    return matchers.some(({ direct, wsl, linux, mounted }) => {
      if (direct(normalized)) {
        return true
      }
      if (!wsl || !cwd.startsWith('/') || cwd.startsWith('//')) {
        return false
      }
      // Mounted host drives are shared; Linux home paths require distro proof.
      return mounted
        ? mounted(normalizeRuntimePathForComparison(toWindowsWslPath(cwd, wsl.distro)))
        : namespace === `wsl:${wsl.distro.toLowerCase()}` && Boolean(linux?.(normalized))
    })
  }
}

/** Translate only applicable scopes before a WSL worker loses UNC database identity. */
export function aiVaultScopePathsForWslDistro(
  scopePaths: readonly string[],
  distro: string
): string[] {
  return scopePaths.flatMap((scopePath) => {
    const wsl = parseWslUncPath(scopePath)
    if (!wsl) {
      return [scopePath]
    }
    if (/^\/mnt\/[A-Za-z](?:\/|$)/.test(wsl.linuxPath)) {
      return [scopePath]
    }
    return wsl.distro.toLowerCase() === distro.toLowerCase() ? [wsl.linuxPath] : []
  })
}
