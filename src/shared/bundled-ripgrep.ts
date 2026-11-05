import { REMOTE_BUNDLE_PLATFORMS, type RemoteBundlePlatform } from './remote-bundle-artifacts'

/** Bundle ripgrep for every relay platform so local/WSL/SSH search never depends on a user-installed rg. */
export const BUNDLED_RIPGREP_PLATFORMS: readonly RemoteBundlePlatform[] = REMOTE_BUNDLE_PLATFORMS
export type BundledRipgrepPlatform = RemoteBundlePlatform
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
