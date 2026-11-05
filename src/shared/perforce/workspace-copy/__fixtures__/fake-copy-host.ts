import { cpSync, readdirSync, statSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import type { TreeCopyResult } from '../workspace-copy-clone-tree'
import type { HostProcess, WorkspaceCopyHost } from '../workspace-copy-host'
import type { FakePerforceServer } from './fake-perforce-server'

function diskUsage(path: string): number {
  let total = 0
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const full = join(path, entry.name)
    total += entry.isDirectory() ? diskUsage(full) : statSync(full).size
  }
  return total
}

export type FakeHostOptions = {
  /** When false, copies cost their full size, as on NTFS. */
  blockClones?: boolean
  processes?: HostProcess[]
  /** Pid to the folder it has open, as the kernel's per-file list reports it. */
  folderHolders?: Map<number, string>
}

/** A copy host over a fake Perforce server and a tree copier that can pretend to block-clone. */
export function createFakeCopyHost(
  server: FakePerforceServer,
  diskRoot: string,
  options: FakeHostOptions = {}
): WorkspaceCopyHost & { copyCalls: string[][]; endedPids: number[] } {
  const capacity = 500 * 1024 ** 3
  let clonedBytes = 0
  const copyCalls: string[][] = []
  const endedPids: number[] = []
  return {
    copyCalls,
    endedPids,
    p4: (args, runOptions) => server.run(args, runOptions),
    platform: 'windows',
    copyTree: async (source, destination, exclusions): Promise<TreeCopyResult> => {
      copyCalls.push([source, destination])
      const skipDirs = exclusions.folders.map((p) => resolve(p).toLowerCase())
      const skipFiles = exclusions.files.map((p) => resolve(p).toLowerCase())
      let files = 0
      let bytes = 0
      cpSync(source, destination, {
        recursive: true,
        preserveTimestamps: true,
        filter: (path) => {
          const key = resolve(path).toLowerCase()
          if (skipDirs.some((dir) => key === dir || key.startsWith(`${dir}${sep}`))) {
            return false
          }
          if (skipFiles.includes(key)) {
            return false
          }
          const info = statSync(path)
          if (info.isFile()) {
            files += 1
            bytes += info.size
          }
          return true
        }
      })
      if (options.blockClones !== false) {
        clonedBytes += bytes
      }
      return { ok: true, files, bytes, cloned: null }
    },
    windowsBuild: () => 26200,
    freeBytes: async () => capacity - (diskUsage(diskRoot) - clonedBytes),
    removeTree: (path) => rm(path, { recursive: true, force: true }),
    listProcesses: async () => options.processes ?? [],
    listFolderHolders: async () => options.folderHolders ?? null,
    endProcess: async (target) => {
      const running = options.processes ?? []
      const index = running.findIndex((p) => p.pid === target.pid)
      if (index !== -1) {
        running.splice(index, 1)
        endedPids.push(target.pid)
      }
      return true
    }
  }
}
