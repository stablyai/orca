import { rm, statfs } from 'node:fs/promises'
import { release } from 'node:os'
import { toNamespacedPath } from 'node:path'
import { runProcess } from '../../child-process/run-process'
import { windowsSystem32Binary } from '../../child-process/windows-system-binary'
import { transientLockRemovalOptions } from '../../windows-transient-lock-removal'
import { runP4, type P4CommandResult, type P4RunOptions } from '../p4-command'

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

export type ProcessOutput = {
  code: number | null
  stdout: string
  stderr: string
}

/** Everything the copy engine touches outside the filesystem; tests swap in a fake Perforce server. */
export type WorkspaceCopyHost = {
  p4: (args: readonly string[], options: P4RunOptions) => Promise<P4CommandResult>
  robocopy: (args: readonly string[]) => Promise<ProcessOutput>
  /** Windows build number, or null off Windows. */
  windowsBuild: () => number | null
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

export function createWorkspaceCopyHost(
  overrides: Partial<
    Pick<WorkspaceCopyHost, 'removeTree' | 'listProcesses' | 'listFolderHolders' | 'endProcess'>
  > = {}
): WorkspaceCopyHost {
  return {
    p4: (args, options) =>
      runP4(args, {
        timeoutMs: LONG_P4_TIMEOUT_MS,
        maxOutputBytes: LARGE_P4_OUTPUT_BYTES,
        requireCompleteOutput: true,
        ...options
      }),
    robocopy: async (args) => {
      const result = await runProcess({
        program: windowsSystem32Binary('robocopy.exe'),
        args,
        timeoutMs: ROBOCOPY_TIMEOUT_MS
      })
      if (result.timedOut) {
        throw new Error('robocopy timed out')
      }
      return {
        code: result.code,
        stdout: result.stdout,
        stderr: result.stderr
      }
    },
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
