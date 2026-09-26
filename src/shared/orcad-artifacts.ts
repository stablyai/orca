/**
 * What a packaged `orcad` directory must contain, declared once — the same single-source
 * treatment `relay-artifacts.ts` gives the relay, for the same reason: the build, the
 * content hash and the remote install probe must not keep three lists that drift.
 *
 * Order is load-bearing: the hash concatenates these files in sequence.
 *
 * Keep this file erasable-only TypeScript — build-orcad.mjs imports it directly under
 * Node's type stripping, which rejects enums, namespaces and parameter properties.
 */
export const ORCAD_BUN_RUNTIME_FILENAME = 'bun-runtime'
export const ORCAD_WINDOWS_BUN_RUNTIME_FILENAME = 'bun-runtime.exe'
export const ORCAD_WINDOWS_PROCESS_TREE_FILENAME = 'windows-process-tree.node'

export function orcadBunRuntimeFilename(target: string): string {
  return target === 'win32' || target.startsWith('win32-')
    ? ORCAD_WINDOWS_BUN_RUNTIME_FILENAME
    : ORCAD_BUN_RUNTIME_FILENAME
}

/** Keep renamed Windows executables in a new content-addressed slot. */
export function orcadArtifactHashPrefix(target: string): string {
  return orcadBunRuntimeFilename(target) === ORCAD_WINDOWS_BUN_RUNTIME_FILENAME
    ? `${ORCAD_WINDOWS_BUN_RUNTIME_FILENAME}\0`
    : ''
}
export const ORCAD_BUILD_TARGET_FILENAME = '.build-target'
export const ORCAD_PARCEL_WATCHER_ENTRY = 'node_modules/@parcel/watcher/index.js'
export const ORCAD_PARCEL_WATCHER_NATIVE = 'node_modules/@parcel/watcher/watcher.node'
export const ORCAD_EMOJI_SHORTCODE_DATASET =
  'node_modules/emojibase-data/en/shortcodes/emojibase.json'

export const ORCAD_VERSION = '0.1.0'

// Kept here because build-orcad.mjs imports this manifest directly under Node type stripping.
export const ORCAD_RIPGREP_ARTIFACTS = [
  'ripgrep/linux-x64/rg',
  'ripgrep/linux-arm64/rg',
  'ripgrep/darwin-x64/rg',
  'ripgrep/darwin-arm64/rg',
  'ripgrep/win32-x64/rg.exe',
  'ripgrep/win32-arm64/rg.exe'
] as const

export const ORCAD_RIPGREP_LICENSE_ARTIFACTS = [
  'ripgrep/licenses/JEMALLOC-COPYING',
  'ripgrep/licenses/LICENSE-MIT',
  'ripgrep/licenses/LLVM-LIBUNWIND-LICENSE.TXT',
  'ripgrep/licenses/MUSL-COPYRIGHT',
  'ripgrep/licenses/PCRE2-LICENCE.md',
  'ripgrep/licenses/README.md',
  'ripgrep/licenses/RUST-CRATE-NOTICES.txt',
  'ripgrep/licenses/SLJIT-LICENSE',
  'ripgrep/licenses/UNLICENSE'
] as const

export type OrcadArtifact = {
  filename: string
  /**
   * Absence is a degradation, not a torn install, so the remote probe must not require it.
   * The agent-browser binary is the only one: `resolveOrcadBrowserProvider` already answers
   * "no headless browser" when it is missing, and it is named per platform-arch anyway.
   */
  optional?: boolean
}

export const ORCAD_ARTIFACTS: readonly OrcadArtifact[] = [
  { filename: 'orcad.js' },
  // Forked so a native @parcel/watcher fault kills the child, not the server.
  { filename: 'parcel-watcher-process-entry.js' },
  // Forked so PTYs outlive the runtime process; its absence makes every restart destructive.
  { filename: 'daemon-entry.js' },
  { filename: 'windows-bun-pty-gate-entry.js' },
  { filename: 'profile-state-writer-worker-entry.js' },
  { filename: 'profile-state-backup-worker-entry.js' },
  // Target-specific even when the JavaScript bundle is shared across packaged slots.
  { filename: ORCAD_BUILD_TARGET_FILENAME },
  // orcad never depends on a host runtime or host-installed native module.
  { filename: ORCAD_BUN_RUNTIME_FILENAME },
  { filename: ORCAD_PARCEL_WATCHER_ENTRY },
  { filename: ORCAD_PARCEL_WATCHER_NATIVE },
  { filename: ORCAD_EMOJI_SHORTCODE_DATASET },
  ...ORCAD_RIPGREP_ARTIFACTS.map((filename) => ({ filename })),
  ...ORCAD_RIPGREP_LICENSE_ARTIFACTS.map((filename) => ({ filename }))
]

/** Written after the artifacts, so it is never an input to its own hash. */
export const ORCAD_VERSION_FILENAME = '.version'
export const ORCAD_TEMPLATE_MANIFEST_FILENAME = 'orcad-template.json'
export const ORCAD_TEMPLATE_TARGETS_DIR = 'targets'

/** Written last by the installer; its absence means a torn install. */
export const ORCAD_INSTALL_COMPLETE_FILENAME = '.install-complete'

export function orcadArtifactFilenames(target = ''): string[] {
  const filenames = ORCAD_ARTIFACTS.filter((artifact) => !artifact.optional).map((artifact) =>
    artifact.filename === ORCAD_BUN_RUNTIME_FILENAME
      ? orcadBunRuntimeFilename(target)
      : artifact.filename
  )
  if (target === 'win32' || target.startsWith('win32-')) {
    filenames.push(ORCAD_WINDOWS_PROCESS_TREE_FILENAME)
  }
  return filenames
}

export function orcadTemplateCommonFilenames(): string[] {
  return orcadArtifactFilenames().filter(
    (filename) =>
      filename !== ORCAD_BUN_RUNTIME_FILENAME &&
      filename !== ORCAD_BUILD_TARGET_FILENAME &&
      filename !== ORCAD_PARCEL_WATCHER_NATIVE
  )
}
