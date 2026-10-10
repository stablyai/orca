import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { nameDarwinTerminals } from './darwin-terminal-names'
import { PS_ARGS } from './process-table-snapshot'

type DeviceEntry = {
  name: string
  rdev: bigint
  kind?: 'character' | 'symlink' | 'file'
  delayMs?: number
  error?: Error
}

class TestDeviceDirectory {
  entries: DeviceEntry[] = []
  openedPaths: string[] = []
  readPaths: string[] = []
  closedDirectories = 0
  peakReads = 0
  openError?: Error
  enumerationError?: Error
  private activeReads = 0

  openDirectory = async (path: string): Promise<AsyncIterable<{ name: string }>> => {
    this.openedPaths.push(path)
    if (this.openError) {
      throw this.openError
    }
    return this.enumerate()
  }

  private async *enumerate(): AsyncGenerator<{ name: string }> {
    try {
      for (const entry of this.entries) {
        yield { name: entry.name }
        if (this.enumerationError) {
          throw this.enumerationError
        }
      }
    } finally {
      this.closedDirectories += 1
    }
  }

  readDevice = async (
    path: string
  ): Promise<{ rdev: bigint; isCharacterDevice: () => boolean }> => {
    this.readPaths.push(path)
    const entry = this.entries.find((candidate) => join('/dev', candidate.name) === path)
    if (!entry) {
      throw new Error('device disappeared')
    }
    this.activeReads += 1
    this.peakReads = Math.max(this.peakReads, this.activeReads)
    try {
      await new Promise((resolve) => setTimeout(resolve, entry.delayMs ?? 1))
      if (entry.error) {
        throw entry.error
      }
      return {
        rdev: entry.rdev,
        isCharacterDevice: () => (entry.kind ?? 'character') === 'character'
      }
    } finally {
      this.activeReads -= 1
    }
  }
}

function darwinRow(
  device: string,
  command = '/bin/zsh',
  start = 'Fri Oct  9 12:34:56 2026'
): string {
  return ` 123 1 123 123 S+ ${device} ${start} ${command}\r\n`
}

describe('nameDarwinTerminals', () => {
  it.each([
    'Fri Oct  9 12:34:56 2026',
    '金 10月  9 12:34:56 2026',
    'Fr  9. Okt 12:34:56 2026',
    'Пт окт  9 12:34:56 2026'
  ])('preserves localized start markers and complete command whitespace (%s)', async (start) => {
    const directory = new TestDeviceDirectory()
    directory.entries = [{ name: 'ttys009', rdev: 0x10000009n }]
    const command = 'node\t--date="2026 10 09"\t\t--device=16/9  --flag'

    expect(await nameDarwinTerminals(darwinRow('16/9', command, start), directory)).toBe(
      darwinRow('ttys009', command, start)
    )
    expect(directory.openedPaths).toEqual(['/dev'])
    expect(directory.closedDirectories).toBe(1)
  })

  it('preserves short and nonstandard opaque tails including date-only rows', async () => {
    const directory = new TestDeviceDirectory()
    directory.entries = [{ name: 'ttys009', rdev: 0x10000009n }]
    const tails = ['truncated', '2026年10月9日 12:34:56 node', 'Fri Oct  9 12:34:56 2026']
    const capture = tails.map((tail) => darwinRow('16/9', '', tail)).join('')
    expect(await nameDarwinTerminals(capture, directory)).toBe(
      tails.map((tail) => darwinRow('ttys009', '', tail)).join('')
    )
  })

  it('discovers a previously unknown device on the next capture', async () => {
    const directory = new TestDeviceDirectory()
    expect(await nameDarwinTerminals(darwinRow('16/9'), directory)).toBe(darwinRow('??'))

    directory.entries = [{ name: 'ttys009', rdev: 0x10000009n }]
    expect(await nameDarwinTerminals(darwinRow('16/9'), directory)).toBe(darwinRow('ttys009'))
    directory.entries = []
    expect(await nameDarwinTerminals(darwinRow('16/9'), directory)).toBe(darwinRow('??'))
    directory.entries = [{ name: 'ttys009', rdev: 0x10000009n }]
    expect(await nameDarwinTerminals(darwinRow('16/9'), directory)).toBe(darwinRow('ttys009'))
    expect(directory.openedPaths).toEqual(['/dev', '/dev', '/dev', '/dev'])
  })

  it('updates a known device name after a rename between captures', async () => {
    const directory = new TestDeviceDirectory()
    directory.entries = [{ name: 'cu.before', rdev: 0x1600002an }]
    expect(await nameDarwinTerminals(darwinRow('22/42'), directory)).toBe(darwinRow('cu.before'))

    directory.entries = [{ name: 'cu.after', rdev: 0x1600002an }]
    expect(await nameDarwinTerminals(darwinRow('22/42'), directory)).toBe(darwinRow('cu.after'))
    expect(directory.readPaths).toEqual([join('/dev', 'cu.before'), join('/dev', 'cu.after')])
  })

  it('chooses the first directory alias despite lexical and completion order', async () => {
    const directory = new TestDeviceDirectory()
    directory.entries = [
      { name: 'z-first', rdev: 0x10000009n, delayMs: 20 },
      { name: 'a-later', rdev: 0x10000009n, delayMs: 0 }
    ]

    expect(await nameDarwinTerminals(darwinRow('16/9'), directory)).toBe(darwinRow('z-first'))
  })

  it('inspects every entry and keeps complete serial names while excluding links and files', async () => {
    const directory = new TestDeviceDirectory()
    directory.entries = [
      { name: 'tty-link', rdev: 0x1600002an, kind: 'symlink' },
      { name: 'tty-file', rdev: 0x1600002an, kind: 'file' },
      { name: 'null', rdev: 0x03000002n },
      { name: 'cu.serial-adapter', rdev: 0x1600002an },
      { name: 'unrelated-entry', rdev: 0n, kind: 'file' }
    ]

    expect(await nameDarwinTerminals(darwinRow('22/42'), directory)).toBe(
      darwinRow('cu.serial-adapter')
    )
    expect(directory.readPaths).toEqual(directory.entries.map((entry) => join('/dev', entry.name)))
  })

  it('stops scheduling stats after cancellation while draining all active reads', async () => {
    const directory = new TestDeviceDirectory()
    directory.entries = Array.from({ length: 20 }, (_, index) => ({
      name: `entry-${index}`,
      rdev: BigInt(index),
      delayMs: 10
    }))
    const controller = new AbortController()
    const named = nameDarwinTerminals(darwinRow('16/9'), directory, controller.signal)
    const rejection = expect(named).rejects.toThrow()
    await new Promise((resolve) => setTimeout(resolve, 2))
    expect(directory.readPaths).toHaveLength(1)
    controller.abort()
    await rejection

    expect(directory.readPaths).toHaveLength(1)
    expect(directory.closedDirectories).toBe(1)
    expect(directory.peakReads).toBe(1)
  })

  it('bounds large inventories and closes the directory without admitting device reads', async () => {
    const directory = new TestDeviceDirectory()
    directory.entries = Array.from({ length: 20_000 }, (_, index) => ({
      name: `entry-${index}-${'x'.repeat(240)}`,
      rdev: 0n
    }))

    await expect(nameDarwinTerminals(darwinRow('16/9'), directory)).rejects.toThrow(
      'Directory listing is too large'
    )
    expect(directory.readPaths).toEqual([])
    expect(directory.closedDirectories).toBe(1)
  })

  it('skips individual stat failures and uses the next direct character alias', async () => {
    const directory = new TestDeviceDirectory()
    directory.entries = [
      { name: 'gone', rdev: 0x10000009n, error: new Error('ENOENT') },
      { name: 'denied', rdev: 0x10000009n, error: new Error('EACCES') },
      { name: 'ttys009', rdev: 0x10000009n }
    ]

    expect(await nameDarwinTerminals(darwinRow('16/9'), directory)).toBe(darwinRow('ttys009'))
  })

  it('rejects directory open failures so the reader can fall back to ordinary tty ps', async () => {
    const directory = new TestDeviceDirectory()
    directory.openError = new Error('cannot open /dev')

    await expect(nameDarwinTerminals(darwinRow('16/9'), directory)).rejects.toThrow(
      'cannot open /dev'
    )
    expect(directory.readPaths).toEqual([])
  })

  it('closes an interrupted directory iterator and rejects partial inventories', async () => {
    const directory = new TestDeviceDirectory()
    directory.entries = [{ name: 'ttys009', rdev: 0x10000009n }]
    directory.enumerationError = new Error('directory enumeration failed')

    await expect(nameDarwinTerminals(darwinRow('16/9'), directory)).rejects.toThrow(
      'directory enumeration failed'
    )
    expect(directory.closedDirectories).toBe(1)
    expect(directory.readPaths).toEqual([])
  })

  it('leaves valid no-terminal rows unchanged without a scan', async () => {
    const directory = new TestDeviceDirectory()
    directory.openError = new Error('must not open')
    const capture = `\r\n${darwinRow('??', 'node --device=16/9')}\n`

    expect(await nameDarwinTerminals(capture, directory)).toBe(capture)
    expect(directory.openedPaths).toEqual([])
  })

  it.each([
    '123 1 S+ node 16/9\n',
    'not-pid 1 123 123 S+ 16/9 tail\n',
    '123 nope 123 123 S+ 16/9 tail\n',
    '123 1 nope 123 S+ 16/9 tail\n',
    '123 1 123 nope S+ 16/9 tail\n',
    'PID PPID PGID TPGID STAT TDEV STARTED COMMAND\n',
    '123 1 123 123 S+ 16/9 \t\r\n'
  ])('rejects unsupported row framing without a device scan (%s)', async (row) => {
    const directory = new TestDeviceDirectory()
    await expect(nameDarwinTerminals(darwinRow('16/9') + row, directory)).rejects.toThrow(
      'malformed_darwin_device_row'
    )
    expect(directory.openedPaths).toEqual([])
  })

  it('maps malformed or out-of-range device tokens to the ordinary unknown marker', async () => {
    const directory = new TestDeviceDirectory()
    const capture = ['not-a-device', '-1/0', '1/-1', '256/0', '1/16777216', '1.0/1', '16,9']
      .map((device) => darwinRow(device))
      .join('')
    expect(await nameDarwinTerminals(capture, directory)).toBe(darwinRow('??').repeat(7))
    expect(directory.openedPaths).toEqual([])
  })

  it('rejects undecodable filenames and closes the directory before any stat reads', async () => {
    const directory = new TestDeviceDirectory()
    directory.entries = [
      { name: 'ttys009', rdev: 0x10000009n },
      { name: 'serial-\uFFFD', rdev: 0x1600002an }
    ]
    await expect(nameDarwinTerminals(darwinRow('16/9'), directory)).rejects.toThrow(
      'undecodable_device_name'
    )
    expect(directory.closedDirectories).toBe(1)
    expect(directory.readPaths).toEqual([])
  })

  it('accepts signed and sign-extended device numbers while ignoring arbitrary wide rdev', async () => {
    const directory = new TestDeviceDirectory()
    directory.entries = [
      { name: 'signed-device', rdev: -2147483525n },
      { name: 'sign-extended-device', rdev: 0xffffffff8000007cn },
      { name: 'high-device', rdev: 0xfffffffen },
      { name: 'wide-device', rdev: 0x1001600002an }
    ]
    const capture = ['128/123', '128/124', '255/16777214', '22/42']
      .map((device) => darwinRow(device))
      .join('')

    expect(await nameDarwinTerminals(capture, directory)).toBe(
      ['signed-device', 'sign-extended-device', 'high-device', '??']
        .map((device) => darwinRow(device))
        .join('')
    )
  })

  it.each(['x'.repeat(255), `${'é'.repeat(127)}x`])(
    'uses the Apple buffer limit for the first alias (%s)',
    async (oversizedName) => {
      const directory = new TestDeviceDirectory()
      directory.entries = [
        { name: oversizedName, rdev: 0x10000009n },
        { name: 'later-short-alias', rdev: 0x10000009n }
      ]

      expect(await nameDarwinTerminals(darwinRow('16/9'), directory)).toBe(darwinRow('??'))
    }
  )

  it('accepts a 254-byte multibyte alias without stripping its basename', async () => {
    const directory = new TestDeviceDirectory()
    const name = 'é'.repeat(127)
    directory.entries = [{ name, rdev: 0x10000009n }]

    expect(await nameDarwinTerminals(darwinRow('16/9'), directory)).toBe(darwinRow(name))
  })

  it('admits one device read at a time while inspecting the full directory', async () => {
    const directory = new TestDeviceDirectory()
    directory.entries = Array.from({ length: 21 }, (_, index) => ({
      name: `entry-${index}`,
      rdev: BigInt(index),
      delayMs: 1
    }))

    expect(await nameDarwinTerminals(darwinRow('16/9'), directory)).toBe(darwinRow('??'))
    expect(directory.peakReads).toBe(1)
    expect(directory.readPaths).toHaveLength(directory.entries.length)
  })

  it('keeps the canonical public ps arguments on both Darwin and Linux', () => {
    expect(PS_ARGS).toEqual([
      '-axo',
      process.platform === 'darwin'
        ? 'pid=,ppid=,pgid=,tpgid=,stat=,tty=,lstart=,command='
        : 'pid=,ppid=,pgid=,tpgid=,stat=,tty=,etimes=,command='
    ])
  })
})
