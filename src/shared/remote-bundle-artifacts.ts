/** Shared WSL guest/ripgrep artifact names. Keep erasable-only TypeScript: Node build-wsl-guest.mjs imports via type stripping,
 * which rejects enums, namespaces and parameter properties. */

/** Every host platform Orca bundles programs for. */
export const REMOTE_BUNDLE_PLATFORMS = [
  'linux-x64',
  'linux-arm64',
  'darwin-x64',
  'darwin-arm64',
  'win32-x64',
  'win32-arm64'
] as const

export type RemoteBundlePlatform = (typeof REMOTE_BUNDLE_PLATFORMS)[number]

export const OPENCODE_SQLITE_READER_FILENAME = 'opencode-sqlite-reader.cjs'
/** Built into the WSL guest bundle dir (out/relay/wsl). */
export const WSL_CLAUDE_PROFILE_HELPER_FILENAME = 'claude-profile-wsl.cjs'
