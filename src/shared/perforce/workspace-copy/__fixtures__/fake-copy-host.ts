import { cpSync, readdirSync, statSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import type { HostProcess, ProcessOutput, WorkspaceCopyHost } from '../workspace-copy-host'
import type { FakePerforceServer } from './fake-perforce-server'

function diskUsage(path: string): number {
  let total = 0
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const full = join(path, entry.name)
    total += entry.isDirectory() ? diskUsage(full) : statSync(full).size
  }
  return total
}

function listAfter(args: readonly string[], flag: string): string[] {
  const start = args.indexOf(flag)
  if (start === -1) {
    return []
  }
  const end = args.findIndex((arg, i) => i > start && arg.startsWith('/'))
  return args.slice(start + 1, end === -1 ? undefined : end).map((p) => resolve(p).toLowerCase())
}

export type FakeHostOptions = {
  /** When false, copies cost their full size, as on NTFS. */
  blockClones?: boolean
  processes?: HostProcess[]
  /** Pid to the folder it has open, as the kernel's per-file list reports it. */
  folderHolders?: Map<number, string>
}

/** A copy host over a fake Perforce server and a robocopy stand-in that can pretend to block-clone. */
export function createFakeCopyHost(
  server: FakePerforceServer,
  diskRoot: string,
  options: FakeHostOptions = {}
): WorkspaceCopyHost & { robocopyCalls: string[][]; endedPids: number[] } {
  const capacity = 500 * 1024 ** 3
  let clonedBytes = 0
  const robocopyCalls: string[][] = []
  const endedPids: number[] = []
  return {
    robocopyCalls,
    endedPids,
    p4: (args, runOptions) => server.run(args, runOptions),
    robocopy: async (args): Promise<ProcessOutput> => {
      robocopyCalls.push([...args])
      const [source, destination] = args
      const skipDirs = listAfter(args, '/XD')
      const skipFiles = listAfter(args, '/XF')
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
      const row = (label: string, n: number): string => `   ${label} :  ${n}  ${n}  0  0  0  0`
      return {
        code: 1,
        stdout: [row('Dirs', 1), row('Files', files), row('Bytes', bytes)].join('\n'),
        stderr: ''
      }
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
