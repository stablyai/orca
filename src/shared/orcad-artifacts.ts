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
// Bun-era slots only: kept so a client can still launch one for rollback (design D7.1 R5).
export const ORCAD_BUN_RUNTIME_FILENAME = 'bun-runtime'
export const ORCAD_WINDOWS_BUN_RUNTIME_FILENAME = 'bun-runtime.exe'
export const ORCAD_BUILD_TARGET_FILENAME = '.build-target'
export const ORCAD_WINDOWS_PROCESS_TREE_FILENAME = 'windows-process-tree.node'

export function orcadBunRuntimeFilename(target: string): string {
  return isWindowsTarget(target) ? ORCAD_WINDOWS_BUN_RUNTIME_FILENAME : ORCAD_BUN_RUNTIME_FILENAME
}

function isWindowsTarget(target: string): boolean {
  return target === 'win32' || target.startsWith('win32-')
}

/** A Node slot's server target (e.g. linux-x64-musl); `.build-target` would mark it as Bun. */
export const ORCAD_SERVER_TARGET_FILENAME = '.server-target'

/**
 * Marks a slot launched by the pinned Node runtime; its content is that runtime's
 * executableSha256 (node-runtime-pin.ts), which is how the runtime enters the version hash.
 * A Node slot must never carry `.build-target`: Bun-era selectors exit 78 on `.build-target`
 * without `bun-runtime` (design D7.1 R5).
 */
export const ORCAD_NODE_RUNTIME_MARKER_FILENAME = '.runtime-node'
/** Beside the slot dirs and shared across Orca versions (design D2): `runtimes/node-<sha256>/bin/node`. */
export const ORCAD_RUNTIMES_DIRNAME = 'runtimes'
export const ORCAD_NODE_RUNTIME_DIR_PREFIX = 'node-'
export const ORCAD_NODE_RUNTIME_POSIX_EXECUTABLE = 'bin/node'
// Upstream's own name and layout: renaming node.exe is the masquerading pattern EDR scores.
export const ORCAD_NODE_RUNTIME_WINDOWS_EXECUTABLE = 'node.exe'

export function orcadNodeRuntimeExecutable(target: string): string {
  return isWindowsTarget(target)
    ? ORCAD_NODE_RUNTIME_WINDOWS_EXECUTABLE
    : ORCAD_NODE_RUNTIME_POSIX_EXECUTABLE
}

/** Slot-relative path segments of the runtime a slot's marker names. */
export function orcadNodeRuntimeRelativePath(target: string, executableSha256: string): string[] {
  return [
    '..',
    ORCAD_RUNTIMES_DIRNAME,
    `${ORCAD_NODE_RUNTIME_DIR_PREFIX}${executableSha256}`,
    ...orcadNodeRuntimeExecutable(target).split('/')
  ]
}

/** N-API level the slot addons are built for; equals SLOT_NAPI_VERSION in the prebuild script. */
export const ORCAD_ADDON_NAPI_VERSION = 8

export const ORCAD_NODE_PTY_DIR = 'node_modules/node-pty'
// Test files and sources stay out; these are every module the runtime path requires.
export const ORCAD_NODE_PTY_JS_ARTIFACTS = [
  'package.json',
  'lib/conpty_console_list_agent.js',
  'lib/eventEmitter2.js',
  'lib/index.js',
  'lib/interfaces.js',
  'lib/shared/conout.js',
  'lib/terminal.js',
  'lib/types.js',
  'lib/unixTerminal.js',
  'lib/utils.js',
  'lib/windowsConoutConnection.js',
  'lib/windowsPtyAgent.js',
  'lib/windowsTerminal.js',
  'lib/worker/conoutSocketWorker.js'
].map((file) => `${ORCAD_NODE_PTY_DIR}/${file}`)

/** The prebuild slot's files (config/scripts/orcad-prebuild-slot-contents.mjs), relative to build/Release. */
export function orcadNodePtySlotFiles(target: string): string[] {
  if (isWindowsTarget(target)) {
    return [
      'conpty.node',
      'conpty_console_list.node',
      'conpty/conpty.dll',
      'conpty/OpenConsole.exe'
    ]
  }
  return target.startsWith('darwin-') ? ['pty.node', 'spawn-helper'] : ['pty.node']
}

export function orcadNodePtyNativeArtifacts(target: string): string[] {
  return orcadNodePtySlotFiles(target).map((file) => `${ORCAD_NODE_PTY_DIR}/build/Release/${file}`)
}

export const ORCAD_PARCEL_WATCHER_ENTRY = 'node_modules/@parcel/watcher/index.js'
export const ORCAD_PARCEL_WATCHER_NATIVE = 'node_modules/@parcel/watcher/watcher.node'
export const ORCAD_EMOJI_SHORTCODE_DATASET =
  'node_modules/emojibase-data/en/shortcodes/emojibase.json'

export const ORCAD_VERSION = '0.1.0'

// Equals FOREIGN_SQLITE_READER_ENTRY_FILENAME; that module is not loadable under type stripping.
export const ORCAD_FOREIGN_SQLITE_READER_ENTRY = 'foreign-sqlite-reader-entry.js'

// Kept here because build-orcad.mjs imports this manifest directly under Node type stripping.
export const ORCAD_RIPGREP_ARTIFACTS = [
  'ripgrep/linux-x64/rg',
  'ripgrep/linux-arm64/rg',
  'ripgrep/darwin-x64/rg',
  'ripgrep/darwin-arm64/rg',
  'ripgrep/win32-x64/rg.exe',
  'ripgrep/win32-arm64/rg.exe'
] as const

/** Only the target's own ripgrep ships (design D2); both libcs share one static build. */
export function orcadRipgrepArtifact(target: string): string {
  const [platform, arch] = target.split('-')
  const artifact = ORCAD_RIPGREP_ARTIFACTS.find((candidate) =>
    candidate.startsWith(`ripgrep/${platform}-${arch}/`)
  )
  if (!artifact) {
    throw new Error(`orcad ships no ripgrep for ${target}`)
  }
  return artifact
}

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
  { filename: 'profile-state-writer-worker-entry.js' },
  { filename: 'profile-state-backup-worker-entry.js' },
  // Worker thread that reads other apps' SQLite (the OpenCode binder and history) off the event loop.
  { filename: ORCAD_FOREIGN_SQLITE_READER_ENTRY },
  // Target-specific even when the JavaScript bundle is shared across packaged slots.
  { filename: ORCAD_SERVER_TARGET_FILENAME },
  // orcad never depends on a host runtime or host-installed native module.
  { filename: ORCAD_NODE_RUNTIME_MARKER_FILENAME },
  { filename: ORCAD_PARCEL_WATCHER_ENTRY },
  { filename: ORCAD_PARCEL_WATCHER_NATIVE },
  { filename: ORCAD_EMOJI_SHORTCODE_DATASET },
  ...ORCAD_NODE_PTY_JS_ARTIFACTS.map((filename) => ({ filename })),
  ...ORCAD_RIPGREP_LICENSE_ARTIFACTS.map((filename) => ({ filename }))
]

/** Written after the artifacts, so it is never an input to its own hash. */
export const ORCAD_VERSION_FILENAME = '.version'
export const ORCAD_TEMPLATE_MANIFEST_FILENAME = 'orcad-template.json'
export const ORCAD_TEMPLATE_TARGETS_DIR = 'targets'

/** Written last by the installer; its absence means a torn install. */
export const ORCAD_INSTALL_COMPLETE_FILENAME = '.install-complete'

/** Every file a `target` slot ships, in hash order; `target` is `<os>-<arch>[-<libc>]`. */
export function orcadArtifactFilenames(target: string): string[] {
  const filenames = ORCAD_ARTIFACTS.filter((artifact) => !artifact.optional).map(
    (artifact) => artifact.filename
  )
  filenames.push(...orcadNodePtyNativeArtifacts(target), orcadRipgrepArtifact(target))
  if (isWindowsTarget(target)) {
    filenames.push(ORCAD_WINDOWS_PROCESS_TREE_FILENAME)
  }
  return filenames
}

/** Files shared by every template target; the rest live under `targets/<target>/`. */
export function orcadTemplateCommonFilenames(): string[] {
  return ORCAD_ARTIFACTS.filter(
    (artifact) =>
      !artifact.optional &&
      artifact.filename !== ORCAD_SERVER_TARGET_FILENAME &&
      artifact.filename !== ORCAD_NODE_RUNTIME_MARKER_FILENAME &&
      artifact.filename !== ORCAD_PARCEL_WATCHER_NATIVE
  ).map((artifact) => artifact.filename)
}

/** Files stored under the template's `targets/<target>/`, at their slot-relative paths. */
export function orcadTemplateTargetFilenames(target: string): string[] {
  const common = new Set(orcadTemplateCommonFilenames())
  return orcadArtifactFilenames(target).filter((filename) => !common.has(filename))
}
