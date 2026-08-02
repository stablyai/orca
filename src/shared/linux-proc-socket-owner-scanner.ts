import { opendir, readlink } from 'node:fs/promises'
import { posix } from 'node:path'

type LinuxProcSocketOwnerScannerDependencies = {
  readDirectoryNames: (directoryPath: string) => AsyncIterable<string>
  readLink: (filePath: string) => Promise<string>
}

async function* readNodeDirectoryNames(directoryPath: string): AsyncGenerator<string> {
  try {
    const directory = await opendir(directoryPath)
    for await (const entry of directory) {
      yield entry.name
    }
  } catch {}
}

const defaultDependencies: LinuxProcSocketOwnerScannerDependencies = {
  readDirectoryNames: readNodeDirectoryNames,
  readLink: readlink
}

export async function mapLinuxSocketInodesToPids(
  inodes: ReadonlySet<number>,
  dependencies: LinuxProcSocketOwnerScannerDependencies = defaultDependencies
): Promise<Map<number, number>> {
  const result = new Map<number, number>()
  if (inodes.size === 0) {
    return result
  }

  try {
    for await (const pidText of dependencies.readDirectoryNames('/proc')) {
      if (!/^\d+$/.test(pidText)) {
        continue
      }
      const pid = Number.parseInt(pidText, 10)
      const fdDirectory = posix.join('/proc', pidText, 'fd')
      try {
        for await (const fd of dependencies.readDirectoryNames(fdDirectory)) {
          let link: string
          try {
            link = await dependencies.readLink(posix.join(fdDirectory, fd))
          } catch {
            continue
          }
          const match = /^socket:\[(\d+)\]$/.exec(link)
          if (!match) {
            continue
          }
          const inode = Number.parseInt(match[1], 10)
          if (inodes.has(inode)) {
            result.set(inode, pid)
          }
        }
      } catch {
        continue
      }
    }
  } catch {
    return result
  }
  return result
}
