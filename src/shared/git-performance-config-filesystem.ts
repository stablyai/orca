import { open, readFile, realpath } from 'node:fs/promises'
import { runProcess } from '@orca/process-host'

/**
 * Host-side filesystem facts for repository Git tuning. Runs where Git runs
 * (main for native repos, the relay for SSH), never across a connection.
 */

export type MountEntry = { mountPoint: string; fsType: string; local: boolean }

// Why an allowlist: Git's untracked cache trusts directory mtimes, which network,
// FUSE, FAT-family and VM-shared filesystems do not reliably bump.
const LINUX_RELIABLE_MTIME_FILESYSTEMS = new Set([
  'btrfs',
  'bcachefs',
  'ext2',
  'ext3',
  'ext4',
  'f2fs',
  'jfs',
  'overlay',
  'tmpfs',
  'xfs',
  'zfs'
])
const DARWIN_RELIABLE_MTIME_FILESYSTEMS = new Set(['apfs', 'hfs'])

function unescapeLinuxMountField(field: string): string {
  return field.replace(/\\([0-7]{3})/g, (_match, octal: string) =>
    String.fromCharCode(Number.parseInt(octal, 8))
  )
}

/** `/proc/self/mounts`: `device mountpoint fstype options dump pass`. */
export function parseLinuxMounts(text: string): MountEntry[] {
  const entries: MountEntry[] = []
  for (const line of text.split('\n')) {
    const fields = line.split(' ')
    if (fields.length < 3) {
      continue
    }
    entries.push({ mountPoint: unescapeLinuxMountField(fields[1]), fsType: fields[2], local: true })
  }
  return entries
}

/** macOS `mount`: `device on /mount/point (fstype, option, ...)`. */
export function parseDarwinMountOutput(text: string): MountEntry[] {
  const entries: MountEntry[] = []
  for (const line of text.split('\n')) {
    const on = line.indexOf(' on ')
    const options = line.lastIndexOf(' (')
    if (on === -1 || options <= on || !line.endsWith(')')) {
      continue
    }
    const flags = line
      .slice(options + 2, -1)
      .split(',')
      .map((flag) => flag.trim())
    entries.push({
      mountPoint: line.slice(on + 4, options),
      fsType: flags[0] ?? '',
      local: flags.includes('local')
    })
  }
  return entries
}

function isWithinMountPoint(path: string, mountPoint: string): boolean {
  if (mountPoint === '/') {
    return path.startsWith('/')
  }
  return path === mountPoint || path.startsWith(`${mountPoint}/`)
}

/** Longest mount point containing `path`; mounts are POSIX paths on both hosts that need this. */
export function findMountForPath(entries: readonly MountEntry[], path: string): MountEntry | null {
  let best: MountEntry | null = null
  for (const entry of entries) {
    if (
      isWithinMountPoint(path, entry.mountPoint) &&
      (!best || entry.mountPoint.length >= best.mountPoint.length)
    ) {
      best = entry
    }
  }
  return best
}

export function mountHasReliableDirectoryMtime(
  entry: MountEntry | null,
  platform: NodeJS.Platform
): boolean {
  if (!entry) {
    return false
  }
  if (platform === 'darwin') {
    return entry.local && DARWIN_RELIABLE_MTIME_FILESYSTEMS.has(entry.fsType)
  }
  return platform === 'linux' && LINUX_RELIABLE_MTIME_FILESYSTEMS.has(entry.fsType)
}

async function readMountTable(platform: NodeJS.Platform): Promise<MountEntry[]> {
  if (platform === 'linux') {
    return parseLinuxMounts(await readFile('/proc/self/mounts', 'utf8'))
  }
  if (platform === 'darwin') {
    const result = await runProcess({ program: '/sbin/mount', args: [], timeoutMs: 5_000 })
    return result.code === 0 ? parseDarwinMountOutput(result.stdout) : []
  }
  return []
}

/** False whenever the answer is unknown: a missed speedup is cheaper than a stale status. */
export async function detectReliableDirectoryMtime(
  repoPath: string,
  platform: NodeJS.Platform
): Promise<boolean> {
  if (platform !== 'linux' && platform !== 'darwin') {
    return false
  }
  try {
    const [resolved, mounts] = await Promise.all([realpath(repoPath), readMountTable(platform)])
    return mountHasReliableDirectoryMtime(findMountForPath(mounts, resolved), platform)
  } catch {
    return false
  }
}

const INDEX_HEADER_BYTES = 12

/** Entry count from the index header (`DIRC`, version, count); a missing index has none. */
export async function readGitIndexEntryCount(indexPath: string): Promise<number | null> {
  let handle: Awaited<ReturnType<typeof open>> | null = null
  try {
    handle = await open(indexPath, 'r')
    const header = Buffer.alloc(INDEX_HEADER_BYTES)
    const { bytesRead } = await handle.read(header, 0, INDEX_HEADER_BYTES, 0)
    if (bytesRead < INDEX_HEADER_BYTES || header.toString('latin1', 0, 4) !== 'DIRC') {
      return null
    }
    return header.readUInt32BE(8)
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'ENOENT' ? 0 : null
  } finally {
    await handle?.close().catch(() => {})
  }
}
