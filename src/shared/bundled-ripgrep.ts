import { RELAY_BUILD_PLATFORMS, type RelayBuildPlatform } from './relay-artifacts'

/**
 * Orca ships its own ripgrep for every relay platform (from @vscode/ripgrep-universal), so local,
 * WSL, and SSH searches never depend on the user having installed `rg`.
 */
export const BUNDLED_RIPGREP_PLATFORMS: readonly RelayBuildPlatform[] = RELAY_BUILD_PLATFORMS
export type BundledRipgrepPlatform = RelayBuildPlatform
/** Directory under the packaged resources root holding `<platform>/rg[.exe]`. */
export const BUNDLED_RIPGREP_RESOURCE_DIR = 'ripgrep'
/** Package directory holding the same layout in development checkouts. */
export const BUNDLED_RIPGREP_PACKAGE_BIN_DIR = 'node_modules/@vscode/ripgrep-universal/bin'

/** Accepts any `<os>-<arch>` label, so an unbundled platform can still name where rg would live. */
export function bundledRipgrepBinaryName(platform: string): string {
  return platform.startsWith('win32-') ? 'rg.exe' : 'rg'
}

export function toBundledRipgrepPlatform(
  platform: string,
  arch: string
): BundledRipgrepPlatform | null {
  const candidate = `${platform}-${arch}`
  return BUNDLED_RIPGREP_PLATFORMS.find((entry) => entry === candidate) ?? null
}
