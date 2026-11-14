import { rm, statfs, writeFile } from 'node:fs/promises'
import { release } from 'node:os'
import { join, toNamespacedPath } from 'node:path'
import { runProcess } from '@orca/process-host'
import { windowsSystem32Binary } from '@orca/process-host/windows-system-binary'
import { transientLockRemovalOptions } from '../../windows-transient-lock-removal'
import { runP4, type P4CommandResult, type P4RunOptions } from '../p4-command'
import { cloneTree, type TreeCopyResult, type TreeExclusions } from './workspace-copy-clone-tree'
import {
  parseRobocopySummary,
  robocopyArguments,
  robocopyFailed,
  robocopyFailure
} from './workspace-copy-files'
import { copyPlatformOf, type CopyPlatform } from './workspace-copy-platform'

export type HostProcess = {
  pid: number
  name: string
  commandLine: string
  /** Start time (ms), when the host can read it. */
  startedAt?: number | null
  parentPid?: number | null
  /** This Orca or something it started (its terminals, watchers); a copy removal closes those itself. */
  ownedByOrca?: boolean
}

/** Everything the copy engine touches outside the filesystem; tests swap in a fake Perforce server. */
export type WorkspaceCopyHost = {
  p4: (args: readonly string[], options: P4RunOptions) => Promise<P4CommandResult>
  /** How this host clones files; null where copies cannot be made at all. */
  platform: CopyPlatform | null
  /** Copies `source` to `destination` without the excluded full paths, keeping timestamps. */
  copyTree: (
    source: string,
    destination: string,
    exclusions: TreeExclusions
  ) => Promise<TreeCopyResult>
  /** Windows build number, or null off Windows. */
  windowsBuild: () => number | null
  /** Readies the folder that holds the copies, best effort (keeps macOS indexing and backups out). */
  prepareCopiesDir?: (copiesDir: string) => Promise<void>
  freeBytes: (path: string) => Promise<number>
  removeTree: (path: string) => Promise<void>
  /** Optional: names Unity editors on the source and processes holding a copy's folder. */
  listProcesses?: () => Promise<HostProcess[]>
  /** Optional: pids with a handle open in a copy's folder, each with the folder it holds; null when the host cannot tell. */
  listFolderHolders?: (root: string) => Promise<ReadonlyMap<number, string> | null>
  /** Ends one process if it is still the one listed (same pid and start time); true once it is gone. */
  endProcess?: (process: HostProcess) => Promise<boolean>
}

// Why: a whole have-list of a large game workspace (166k files) runs to tens of MB.
const LARGE_P4_OUTPUT_BYTES = 512 * 1024 * 1024
const LONG_P4_TIMEOUT_MS = 30 * 60 * 1000
const ROBOCOPY_TIMEOUT_MS = 2 * 60 * 60 * 1000

export function parseWindowsBuild(osRelease: string): number | null {
  const build = Number(osRelease.split('.')[2])
  return Number.isInteger(build) && build > 0 ? build : null
}

async function robocopyTree(
  source: string,
  destination: string,
  exclusions: TreeExclusions
): Promise<TreeCopyResult> {
  const result = await runProcess({
    program: windowsSystem32Binary('robocopy.exe'),
    args: robocopyArguments(source, destination, exclusions.folders, exclusions.files),
    timeoutMs: ROBOCOPY_TIMEOUT_MS
  })
  if (result.timedOut) {
    throw new Error('robocopy timed out')
  }
  if (robocopyFailed(result.code)) {
    return { ok: false, message: robocopyFailure(result.code, result.stdout) }
  }
  const summary = parseRobocopySummary(result.stdout)
  return { ok: true, files: summary?.files ?? null, bytes: summary?.bytes ?? null, cloned: null }
}

/** Spotlight would index every copy and Time Machine back up what the depot already holds. */
async function keepCopiesOutOfIndexAndBackups(copiesDir: string): Promise<void> {
  await writeFile(join(copiesDir, '.metadata_never_index'), '', { flag: 'a' }).catch(() => {})
  await runProcess({
    program: 'tmutil',
    args: ['addexclusion', copiesDir],
    timeoutMs: 30_000
  }).catch(() => {})
}

export function createWorkspaceCopyHost(
  overrides: Partial<
    Pick<WorkspaceCopyHost, 'removeTree' | 'listProcesses' | 'listFolderHolders' | 'endProcess'>
  > = {}
): WorkspaceCopyHost {
  const platform = copyPlatformOf(process.platform)
  return {
    p4: (args, options) =>
      runP4(args, {
        timeoutMs: LONG_P4_TIMEOUT_MS,
        maxOutputBytes: LARGE_P4_OUTPUT_BYTES,
        requireCompleteOutput: true,
        ...options
      }),
    platform,
    copyTree: platform === 'windows' ? robocopyTree : (from, to, ex) => cloneTree(from, to, ex),
    prepareCopiesDir: platform === 'macos' ? keepCopiesOutOfIndexAndBackups : undefined,
    windowsBuild: () => (process.platform === 'win32' ? parseWindowsBuild(release()) : null),
    freeBytes: async (path) => {
      const stats = await statfs(path)
      return stats.bavail * stats.bsize
    },
    removeTree:
      overrides.removeTree ??
      ((path) =>
        rm(
          process.platform === 'win32' ? toNamespacedPath(path) : path,
          transientLockRemovalOptions()
        )),
    listProcesses: overrides.listProcesses,
    listFolderHolders: overrides.listFolderHolders,
    endProcess: overrides.endProcess
  }
}
