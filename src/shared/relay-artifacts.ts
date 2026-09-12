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
  /**
   * Present only when the build could produce it, so it is hashed when there and
   * never probed. Required artifacts stay required: a probe that demanded an
   * optional one would loop forever redeploying a relay that is already correct.
   */
  optional?: boolean
  /** Current relay build platforms for which this artifact is emitted. */
  platforms?: readonly RelayBuildPlatform[]
  /** Kept in the legacy boolean view for already-built relay packages. */
  legacyOnly?: boolean
  /**
   * Forked by the relay daemon as a long-lived child of its own. These are relay
   * infrastructure, never user work, and the reap gate subtracts them from a daemon's
   * child census; see src/main/ssh/relay-daemon-service-children.ts.
   */
  daemonServiceChild?: boolean
}

/** The bare Windows process-table addon; see docs/reference/windows-process-enumeration.md. */
export const RELAY_WINDOWS_PROCESS_TREE_FILENAME = 'windows-process-tree.node'
/** Optional target-native Bun executable. Node remains the rollback/compatibility path. */
export const RELAY_BUN_RUNTIME_FILENAME = 'bun-runtime'
export const RELAY_WINDOWS_BUN_RUNTIME_FILENAME = 'bun-runtime.exe'
/** Marker written only by strict release bundles that must not use host Node. */
export const RELAY_BUN_REQUIRED_FILENAME = '.bun-required'
/** Optional Linux Bun executable linked against glibc. */
export const RELAY_BUN_GLIBC_RUNTIME_FILENAME = 'bun-runtime-glibc'
/** Optional Linux Bun executable linked against musl. */
export const RELAY_BUN_MUSL_RUNTIME_FILENAME = 'bun-runtime-musl'
export const RELAY_WATCHER_MODULE_INDEX = 'node_modules/@parcel/watcher/index.js'
export const RELAY_WATCHER_MODULE_WRAPPER = 'node_modules/@parcel/watcher/wrapper.js'
export const RELAY_WATCHER_MODULE_PACKAGE = 'node_modules/@parcel/watcher/package.json'
export const RELAY_WATCHER_GLIBC_NATIVE = 'node_modules/@parcel/watcher/native-glibc/watcher.node'
export const RELAY_WATCHER_MUSL_NATIVE = 'node_modules/@parcel/watcher/native-musl/watcher.node'
export const RELAY_WATCHER_NATIVE = 'node_modules/@parcel/watcher/native-native/watcher.node'

/** Map an orcad/relay target to the staged Bun filename used by its package. */
export function relayBunRuntimeFilename(target: string): string {
  if (target === 'win32' || isWindowsRelayPlatform(target)) {
    return RELAY_WINDOWS_BUN_RUNTIME_FILENAME
  }
  if (target.endsWith('-glibc')) {
    return RELAY_BUN_GLIBC_RUNTIME_FILENAME
  }
  if (target.endsWith('-musl')) {
    return RELAY_BUN_MUSL_RUNTIME_FILENAME
  }
  return RELAY_BUN_RUNTIME_FILENAME
}

const NON_LINUX_RELAY_PLATFORMS = [
  'darwin-x64',
  'darwin-arm64',
  'win32-x64',
  'win32-arm64'
] as const
const LINUX_RELAY_PLATFORMS = ['linux-x64', 'linux-arm64'] as const

export const RELAY_ARTIFACTS: readonly RelayArtifact[] = [
  { filename: 'relay.js' },
  { filename: 'relay-watcher.js', daemonServiceChild: true },
  { filename: 'windows-bun-pty-gate-entry.js' },
  { filename: 'relay-ai-vault-service.js', daemonServiceChild: true },
  { filename: 'managed-hook-runtime.js' },
  // Forked by the AI Vault title reader; without it a relay answers every WSL
  // title request with no title and no error.
  { filename: 'wsl-transcript-fs-process-entry.js' },
  { filename: RELAY_WATCHER_MODULE_INDEX },
  { filename: RELAY_WATCHER_MODULE_WRAPPER },
  { filename: RELAY_WATCHER_MODULE_PACKAGE },
  { filename: RELAY_WATCHER_GLIBC_NATIVE, platforms: LINUX_RELAY_PLATFORMS },
  { filename: RELAY_WATCHER_MUSL_NATIVE, platforms: LINUX_RELAY_PLATFORMS },
  { filename: RELAY_WATCHER_NATIVE, platforms: NON_LINUX_RELAY_PLATFORMS },
  // Optional so legacy Node-only relay packages remain valid. Current builds use
  // libc-specific names on Linux; the generic name remains for old packages.
  {
    filename: RELAY_BUN_RUNTIME_FILENAME,
    optional: true,
    platforms: ['darwin-x64', 'darwin-arm64'],
    legacyOnly: true
  },
  { filename: RELAY_WINDOWS_BUN_RUNTIME_FILENAME, optional: true, windowsOnly: true },
  { filename: RELAY_BUN_GLIBC_RUNTIME_FILENAME, optional: true, platforms: LINUX_RELAY_PLATFORMS },
  { filename: RELAY_BUN_MUSL_RUNTIME_FILENAME, optional: true, platforms: LINUX_RELAY_PLATFORMS },
  { filename: RELAY_BUN_REQUIRED_FILENAME, optional: true },
  { filename: 'node-pty-1.1.0-console-list-agent-patch.cjs', windowsOnly: true },
  // The ConPTY teardown release the desktop's own node-pty patch already carries; pnpm patches do
  // not cross the SSH boundary, so a relay ran the unpatched npm tree and leaked one Windows File
  // handle per terminal for the life of the relay process.
  { filename: 'node-pty-1.1.0-windows-pty-teardown-patch.cjs', windowsOnly: true },
  // Only Linux relays run it, but it ships everywhere: the manifest's only
  // platform axis is Windows, and a second one would buy nothing but a fork in
  // the hash. Its presence is what moves a host to a fresh relay directory, and
  // therefore to a re-install that can apply it.
  { filename: 'node-pty-1.1.0-master-cloexec-patch.cjs' },
  // Optional because only a Windows build machine can compile it. Without it the
  // relay reads the process table through a PowerShell scan instead -- slower,
  // but correct, so a relay built anywhere else is still shippable.
  { filename: RELAY_WINDOWS_PROCESS_TREE_FILENAME, windowsOnly: true, optional: true }
]

/**
 * The daemon's own service children, by entry filename. Anything else under a relay pid is
 * either user work or unidentified, and both keep the relay unreapable.
 */
export const RELAY_DAEMON_SERVICE_ENTRY_FILENAMES: readonly string[] = RELAY_ARTIFACTS.filter(
  (artifact) => artifact.daemonServiceChild
).map((artifact) => artifact.filename)

/** Written after the artifacts, so it is never an input to its own hash. */
export const RELAY_VERSION_FILENAME = '.version'

/** Written last by the installer; its absence means a torn install. */
export const RELAY_INSTALL_COMPLETE_FILENAME = '.install-complete'

type RelayArtifactSelector = RelayBuildPlatform | boolean

function artifactMatchesSelector(
  artifact: RelayArtifact,
  selector: RelayArtifactSelector
): boolean {
  if (typeof selector === 'boolean') {
    // The boolean form predates libc-specific staging and is intentionally kept
    // for remote probes and callers that only know the host family.
    if (artifact.legacyOnly) {
      return true
    }
    if (artifact.platforms) {
      return artifact.platforms.some((platform) => isWindowsRelayPlatform(platform) === selector)
    }
    return !artifact.windowsOnly || selector
  }
  if (artifact.platforms && !artifact.platforms.includes(selector)) {
    return false
  }
  return !artifact.windowsOnly || isWindowsRelayPlatform(selector)
}

/** Artifacts every relay must have; the remote install probe requires each one. */
export function relayArtifactFilenames(isWindows: boolean): string[]
export function relayArtifactFilenames(platform: RelayBuildPlatform): string[]
export function relayArtifactFilenames(selector: RelayArtifactSelector): string[] {
  return RELAY_ARTIFACTS.filter(
    (artifact) => !artifact.optional && artifactMatchesSelector(artifact, selector)
  ).map((artifact) => artifact.filename)
}

/** Artifacts a build may or may not emit. Hashed when present, never probed. */
export function relayOptionalArtifactFilenames(isWindows: boolean): string[]
export function relayOptionalArtifactFilenames(platform: RelayBuildPlatform): string[]
export function relayOptionalArtifactFilenames(selector: RelayArtifactSelector): string[] {
  return RELAY_ARTIFACTS.filter(
    (artifact) => artifact.optional && artifactMatchesSelector(artifact, selector)
  ).map((artifact) => artifact.filename)
}
