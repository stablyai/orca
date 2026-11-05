import { randomBytes } from 'node:crypto'
import { lstat, mkdir, open, stat } from 'node:fs/promises'
import { dirname, join, parse } from 'node:path'
import { WorkspaceCopyError } from './workspace-copy-errors'
import type { WorkspaceCopyHost } from './workspace-copy-host'
import { copiesDirFor } from './workspace-copy-names'
import {
  findOwnMarker,
  pathExists,
  resolveCopySource,
  samePath,
  type CopySource
} from './workspace-copy-source'
import { MIN_BLOCK_CLONE_BUILD } from './workspace-copy-platform'
import type { BlockCloningState, WorkspaceCopyReadiness } from './workspace-copy-types'
import { macVolumeProblems } from './workspace-copy-volume'

const PROBE_BYTES = 64 * 1024 * 1024
const PROBE_CHUNK_BYTES = 1024 * 1024
// Why keep a negative answer at all: each probe writes about 256 MB, and the composer asks on every
// open. 'unknown' is never kept, so a skewed measurement is retried.
const NOT_CLONING_TTL_MS = 5 * 60_000
const probedVolumes = new Map<string, { state: 'verified' | 'not-cloning'; at: number }>()

export function resetBlockCloningProbeCacheForTests(): void {
  probedVolumes.clear()
}

async function writeProbeFile(path: string, size: number): Promise<void> {
  const chunk = randomBytes(PROBE_CHUNK_BYTES)
  const handle = await open(path, 'w')
  try {
    for (let written = 0; written < size; written += PROBE_CHUNK_BYTES) {
      await handle.write(chunk)
    }
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function measureClone(host: WorkspaceCopyHost, dir: string): Promise<BlockCloningState> {
  const probe = join(dir, `.orca-clone-probe-${randomBytes(4).toString('hex')}`)
  const from = join(probe, 'from')
  try {
    await mkdir(from, { recursive: true })
    // Why a small probe on macOS: a forced clone either succeeds or fails, free space is not needed.
    const size = host.platform === 'macos' ? PROBE_CHUNK_BYTES : PROBE_BYTES
    const beforeWrite = await host.freeBytes(dir)
    await writeProbeFile(join(from, 'probe.bin'), size)
    const afterWrite = await host.freeBytes(dir)
    const copied = await host.copyTree(from, join(probe, 'to'), { folders: [], files: [] })
    const afterCopy = await host.freeBytes(dir)
    if (!copied.ok) {
      return copied.notCloning ? 'not-cloning' : 'unknown'
    }
    if (copied.cloned) {
      return 'verified'
    }
    // Why: when writing the probe barely moved free space, something else on the drive did too.
    if (beforeWrite - afterWrite < PROBE_BYTES / 2) {
      return 'unknown'
    }
    return afterWrite - afterCopy < PROBE_BYTES / 4 ? 'verified' : 'not-cloning'
  } finally {
    await host.removeTree(probe).catch(() => {})
  }
}

/**
 * Copies a 64 MB file next to the workspace and checks that free space did not drop by its size: the
 * one property copies rely on, measured directly because asking Windows whether a volume is a Dev
 * Drive (`fsutil devdrv query`) needs an elevated shell. On macOS a forced clone answers directly.
 */
export async function probeBlockCloning(
  host: WorkspaceCopyHost,
  dir: string
): Promise<BlockCloningState> {
  // Why the device too: every macOS volume is under the one root `/`.
  const volume = `${parse(dir).root.toLowerCase()}|${(await stat(dir)).dev}`
  const known = probedVolumes.get(volume)
  if (known && (known.state === 'verified' || Date.now() - known.at < NOT_CLONING_TTL_MS)) {
    return known.state
  }
  let state = await measureClone(host, dir)
  if (state !== 'verified') {
    // A second try rules out another writer on the drive skewing one measurement.
    state = await measureClone(host, dir)
  }
  if (state !== 'unknown') {
    probedVolumes.set(volume, { state, at: Date.now() })
  }
  return state
}

function refusalMessage(error: unknown): string {
  if (error instanceof WorkspaceCopyError && error.kind === 'refused') {
    return error.message
  }
  throw error
}

/** Whether copies of the workspace at `dir` can be made, and every reason they cannot. */
export async function checkCopyReadiness(
  host: WorkspaceCopyHost,
  dir: string,
  options: { minFreeBytes?: number; probe?: boolean } = {}
): Promise<WorkspaceCopyReadiness & { resolvedSource: CopySource | null }> {
  const platform = host.platform
  const build = host.windowsBuild()
  const result: WorkspaceCopyReadiness & { resolvedSource: CopySource | null } = {
    ready: false,
    problems: [],
    warnings: [],
    source: null,
    copiesDir: null,
    copyPlatform: platform,
    windowsBuild: build,
    fileSystemFreeBytes: null,
    blockCloning: null,
    resolvedSource: null
  }
  if (platform === null) {
    result.problems.push(
      'Perforce copies need Windows 11 24H2 or later with the workspace on a Dev Drive, or macOS with the workspace on APFS, and the computer this workspace is on runs neither.'
    )
    return result
  }
  if (platform === 'windows' && (build ?? 0) < MIN_BLOCK_CLONE_BUILD) {
    result.problems.push(
      `Perforce copies need Windows 11 24H2 (build ${MIN_BLOCK_CLONE_BUILD}) or later. This computer runs build ${build ?? 'unknown'}, which cannot block-clone files, so each copy would duplicate the whole workspace.`
    )
  }
  try {
    const source = await resolveCopySource(host, dir)
    result.resolvedSource = source
    result.source = {
      client: source.client,
      root: source.root,
      stream: source.stream
    }
    if (!source.stream) {
      result.problems.push(
        `Client ${source.client} is not a stream client; copies are only made of stream workspaces.`
      )
    }
    // Why: a copy is bound and checked from its root, which never finds a config in a subfolder.
    if (!samePath(dirname(source.configPath), source.root)) {
      result.problems.push(
        `P4CLIENT comes from ${source.configPath}, below the workspace root ${source.root}. Copies are bound from their root, so move that file to ${source.root} first.`
      )
    }
    if (await findOwnMarker(source.root)) {
      result.problems.push(
        'This workspace is itself a copy. Make new copies from the original workspace.'
      )
    }
    result.copiesDir = copiesDirFor(source.root)
  } catch (error) {
    result.problems.push(refusalMessage(error))
    return result
  }
  const copiesDir = result.copiesDir
  if (await pathExists(copiesDir)) {
    if ((await lstat(copiesDir)).isSymbolicLink()) {
      result.problems.push(
        `${copiesDir} is a link or junction. Copies must be on the same drive as the workspace, so it has to be a plain folder.`
      )
    }
  }
  if (platform === 'macos' && result.source) {
    result.problems.push(...(await macVolumeProblems(result.source.root, copiesDir)))
  }
  const free = await host.freeBytes((await pathExists(copiesDir)) ? copiesDir : dirname(copiesDir))
  result.fileSystemFreeBytes = free
  const minFree = options.minFreeBytes ?? 0
  if (free < minFree) {
    result.problems.push(
      `The drive has ${formatGb(free)} free, less than the ${formatGb(minFree)} minimum set in Settings > Perforce.`
    )
  } else if (free < minFree * 2) {
    result.warnings.push(
      `The drive has ${formatGb(free)} free. A copy starts at about 1 GB, but opening it in Unity and recompiling writes several GB more.`
    )
  }
  if (result.problems.length === 0 && options.probe !== false) {
    await mkdir(copiesDir, { recursive: true })
    result.blockCloning = await probeBlockCloning(host, copiesDir)
    if (result.blockCloning === 'not-cloning') {
      result.problems.push(
        platform === 'macos'
          ? `The volume holding ${result.source?.root} does not clone files (it is not APFS), so every copy would duplicate the whole workspace. Keep the workspace on an APFS volume.`
          : `The drive holding ${result.source?.root} does not block-clone files (it is not a ReFS Dev Drive), so every copy would duplicate the whole workspace. Move the workspace onto a Dev Drive first.`
      )
    } else if (result.blockCloning === 'unknown') {
      result.warnings.push(
        'Could not confirm block cloning on this drive because its free space changed during the check; each copy reports the space it actually used.'
      )
    }
  }
  result.ready = result.problems.length === 0
  return result
}

export function formatGb(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`
}
