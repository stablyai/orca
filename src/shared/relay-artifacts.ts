/**
 * What a packaged relay directory must contain, declared once. The build, the
 * content hash, and the remote install probe all read this list; they used to
 * keep three of their own, which is how the WSL helper reached the desktop app
 * but never a relay.
 *
 * Order is load-bearing: the hash concatenates these files in sequence.
 *
 * Keep this file erasable-only TypeScript — build-relay.mjs imports it directly
 * under Node's type stripping, which rejects enums, namespaces, and parameter
 * properties.
 */

/** Every platform the relay is bundled for; each gets the full artifact set. */
export const RELAY_BUILD_PLATFORMS = [
  'linux-x64',
  'linux-arm64',
  'darwin-x64',
  'darwin-arm64',
  'win32-x64',
  'win32-arm64'
] as const

export type RelayBuildPlatform = (typeof RELAY_BUILD_PLATFORMS)[number]

export function isWindowsRelayPlatform(platform: string): boolean {
  return platform.startsWith('win32-')
}

export type RelayArtifact = {
  filename: string
  /** Only Windows relays ship it; other hosts must neither receive nor probe it. */
  windowsOnly?: boolean
}

export const RELAY_ARTIFACTS: readonly RelayArtifact[] = [
  { filename: 'relay.js' },
  { filename: 'relay-watcher.js' },
  { filename: 'relay-ai-vault-service.js' },
  { filename: 'managed-hook-runtime.js' },
  // Forked by the AI Vault title reader; without it a relay answers every WSL
  // title request with no title and no error.
  { filename: 'wsl-transcript-fs-process-entry.js' },
  { filename: 'node-pty-1.1.0-console-list-agent-patch.cjs', windowsOnly: true }
]

/** Written after the artifacts, so it is never an input to its own hash. */
export const RELAY_VERSION_FILENAME = '.version'

/** Written last by the installer; its absence means a torn install. */
export const RELAY_INSTALL_COMPLETE_FILENAME = '.install-complete'

export function relayArtifactFilenames(isWindows: boolean): string[] {
  return RELAY_ARTIFACTS.filter((artifact) => !artifact.windowsOnly || isWindows).map(
    (artifact) => artifact.filename
  )
}
