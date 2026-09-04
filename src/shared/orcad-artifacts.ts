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

export const ORCAD_VERSION = '0.1.0'

/**
 * Every entry is required, by the build's emit check and by the remote install probe alike.
 *
 * There is deliberately no `optional` flag. The one artifact that would want it — the
 * agent-browser binary, whose absence `resolveOrcadBrowserProvider` degrades past rather than
 * treating as a torn install — cannot be an entry here at all: its filename is derived per
 * platform-arch. A flag no entry can set reads as a promise this list does not keep, and the
 * single filename accessor feeds two different questions (what the build must emit, what the
 * probe must find), so a silent exemption would quietly stop the build checking its own output.
 */
export type OrcadArtifact = {
  filename: string
}

/** The bundle's entry point, named once: a generated service definition execs this file. */
export const ORCAD_ENTRY_FILENAME = 'orcad.js'

export const ORCAD_ARTIFACTS: readonly OrcadArtifact[] = [
  { filename: ORCAD_ENTRY_FILENAME },
  // Forked so a native @parcel/watcher fault kills the child, not the server.
  { filename: 'parcel-watcher-process-entry.js' },
  // Forked so PTYs outlive the runtime process; its absence makes every restart destructive.
  { filename: 'daemon-entry.js' }
]

/** Written after the artifacts, so it is never an input to its own hash. */
export const ORCAD_VERSION_FILENAME = '.version'

/** Written last by the installer; its absence means a torn install. */
export const ORCAD_INSTALL_COMPLETE_FILENAME = '.install-complete'

export function orcadArtifactFilenames(): string[] {
  return ORCAD_ARTIFACTS.map((artifact) => artifact.filename)
}
