import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  findMountForPath,
  mountHasReliableDirectoryMtime,
  parseDarwinMountOutput,
  parseLinuxMounts,
  readGitIndexEntryCount
} from './git-performance-config-filesystem'

describe('mount tables', () => {
  it('parses macOS mount output, including spaces and the local flag', () => {
    const entries = parseDarwinMountOutput(
      [
        '/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)',
        '/dev/disk3s5 on /System/Volumes/Data (apfs, local, journaled, nobrowse)',
        '//user@nas/share on /Volumes/My Share (smbfs, nodev, nosuid, mounted by user)',
        '/dev/disk5s1 on /Volumes/USB (msdos, local, nodev, nosuid, noowners)'
      ].join('\n')
    )
    const at = (path: string) => findMountForPath(entries, path)
    expect(mountHasReliableDirectoryMtime(at('/Users/me/repo'), 'darwin')).toBe(true)
    expect(at('/Volumes/My Share/repo')).toMatchObject({ fsType: 'smbfs', local: false })
    expect(mountHasReliableDirectoryMtime(at('/Volumes/My Share/repo'), 'darwin')).toBe(false)
    expect(mountHasReliableDirectoryMtime(at('/Volumes/USB/repo'), 'darwin')).toBe(false)
  })

  it('parses /proc/self/mounts, unescapes paths, and allows only known local filesystems', () => {
    const entries = parseLinuxMounts(
      [
        '/dev/sda1 / ext4 rw,relatime 0 0',
        'server:/export /home/me/nfs nfs4 rw 0 0',
        'C:\\134 /mnt/c 9p rw 0 0',
        '/dev/sdb1 /data\\040disk xfs rw 0 0'
      ].join('\n')
    )
    const reliable = (path: string) =>
      mountHasReliableDirectoryMtime(findMountForPath(entries, path), 'linux')
    expect(reliable('/home/me/repo')).toBe(true)
    expect(reliable('/home/me/nfs/repo')).toBe(false)
    expect(reliable('/mnt/c/Users/me/repo')).toBe(false)
    expect(reliable('/data disk/repo')).toBe(true)
    // A prefix that is not a path boundary must not match.
    expect(findMountForPath(entries, '/home/me/nfs-other')?.mountPoint).toBe('/')
  })

  it('treats an unknown mount or other platforms as unreliable', () => {
    expect(mountHasReliableDirectoryMtime(null, 'linux')).toBe(false)
    expect(
      mountHasReliableDirectoryMtime({ mountPoint: '/', fsType: 'ext4', local: true }, 'win32')
    ).toBe(false)
  })
})

describe('readGitIndexEntryCount', () => {
  let dir = ''
  afterEach(async () => {
    if (dir) {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('reads the entry count from the index header and treats a missing index as empty', async () => {
    dir = await mkdtemp(join(tmpdir(), 'orca-index-header-'))
    const header = Buffer.alloc(12)
    header.write('DIRC', 0, 'latin1')
    header.writeUInt32BE(2, 4)
    header.writeUInt32BE(18_600, 8)
    await writeFile(join(dir, 'index'), header)
    await writeFile(join(dir, 'garbage'), 'not an index')

    await expect(readGitIndexEntryCount(join(dir, 'index'))).resolves.toBe(18_600)
    await expect(readGitIndexEntryCount(join(dir, 'missing'))).resolves.toBe(0)
    await expect(readGitIndexEntryCount(join(dir, 'garbage'))).resolves.toBeNull()
  })
})
