import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
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
    expect(directory.openedPaths).toEqual([])
    expect(directory.readPaths).toEqual([join('/dev', 'ttys009')])
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
    expect(directory.openedPaths).toEqual(['/dev', '/dev'])
  })

  it('updates a known device name after a rename between captures', async () => {
    const directory = new TestDeviceDirectory()
    directory.entries = [{ name: 'cu.before', rdev: 0x1600002an }]
    expect(await nameDarwinTerminals(darwinRow('22/42'), directory)).toBe(darwinRow('cu.before'))

    directory.entries = [{ name: 'cu.after', rdev: 0x1600002an }]
    expect(await nameDarwinTerminals(darwinRow('22/42'), directory)).toBe(darwinRow('cu.after'))
    expect(directory.readPaths).toEqual(
      ['ttys042', 'cu.before', 'ttys042', 'cu.after'].map((name) => join('/dev', name))
    )
  })

  it('chooses the first directory alias despite lexical and completion order', async () => {
    const directory = new TestDeviceDirectory()
    directory.entries = [
      { name: 'z-first', rdev: 0x10000009n, delayMs: 20 },
      { name: 'a-later', rdev: 0x10000009n, delayMs: 0 }
    ]

    expect(await nameDarwinTerminals(darwinRow('16/9'), directory)).toBe(darwinRow('z-first'))
  })

  it('scans until a serial name resolves while excluding links and files', async () => {
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
    expect(directory.readPaths).toEqual(
      ['ttys042', 'tty-link', 'tty-file', 'null', 'cu.serial-adapter'].map((name) =>
        join('/dev', name)
      )
    )
  })

  it('stops scheduling stats after cancellation while draining all active reads', async () => {
    const directory = new TestDeviceDirectory()
    directory.entries = Array.from({ length: 20 }, (_, index) => ({
      name: `entry-${index}`,
      rdev: BigInt(index),
      delayMs: 10
    }))
    const controller = new AbortController()
    vi.useFakeTimers()
    const named = nameDarwinTerminals(darwinRow('16/9'), directory, controller.signal)
    let settled = false
    void named.then(
      () => (settled = true),
      () => (settled = true)
    )
    const rejection = expect(named).rejects.toThrow()
    // Cleanup awaits this too if an earlier assertion fails.
    void rejection.catch(() => {})
    try {
      await vi.advanceTimersByTimeAsync(2)
      expect(directory.readPaths).toHaveLength(2)
      controller.abort()
      await vi.advanceTimersByTimeAsync(0)
      expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(8)
      expect(directory.readPaths).toHaveLength(2)
      await rejection

      expect(directory.closedDirectories).toBe(1)
      expect(directory.peakReads).toBe(1)
    } finally {
      controller.abort()
      try {
        await vi.runAllTimersAsync()
        await rejection.catch(() => {})
      } finally {
        vi.useRealTimers()
      }
    }
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
    expect(directory.readPaths).toEqual([join('/dev', 'ttys009')])
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
    expect(directory.readPaths).toEqual([join('/dev', 'ttys009')])
  })

  it('closes an interrupted directory iterator and rejects partial inventories', async () => {
    const directory = new TestDeviceDirectory()
    directory.entries = [{ name: 'cu.device', rdev: 0x10000009n }]
    directory.enumerationError = new Error('directory enumeration failed')

    await expect(nameDarwinTerminals(darwinRow('16/9'), directory)).rejects.toThrow(
      'directory enumeration failed'
    )
    expect(directory.closedDirectories).toBe(1)
    expect(directory.readPaths).toEqual([join('/dev', 'ttys009')])
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

  it('names zero-padded device tokens by their numeric device', async () => {
    const directory = new TestDeviceDirectory()
    directory.entries = [{ name: 'ttys009', rdev: 0x10000009n }]

    expect(await nameDarwinTerminals(darwinRow('016/009'), directory)).toBe(darwinRow('ttys009'))
    expect(directory.readPaths).toEqual([join('/dev', 'ttys009')])
  })

  it('rejects undecodable filenames and closes the directory before any stat reads', async () => {
    const directory = new TestDeviceDirectory()
    directory.entries = [
      { name: 'cu.device', rdev: 0x10000009n },
      { name: 'serial-\uFFFD', rdev: 0x1600002an }
    ]
    await expect(nameDarwinTerminals(darwinRow('16/9'), directory)).rejects.toThrow(
      'undecodable_device_name'
    )
    expect(directory.closedDirectories).toBe(1)
    expect(directory.readPaths).toEqual([join('/dev', 'ttys009')])
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
    expect(directory.readPaths).toHaveLength(directory.entries.length + 1)
  })

  it('resolves a pty with one verified candidate stat and no directory scan', async () => {
    const directory = new TestDeviceDirectory()
    directory.entries = [{ name: 'ttys009', rdev: 0x10000009n }]
    directory.openError = new Error('must not open')

    expect(await nameDarwinTerminals(darwinRow('16/9'), directory)).toBe(darwinRow('ttys009'))
    expect(directory.openedPaths).toEqual([])
    expect(directory.readPaths).toEqual([join('/dev', 'ttys009')])
  })

  it('falls back to the first scanned alias when the pty candidate has another device', async () => {
    const directory = new TestDeviceDirectory()
    directory.entries = [
      { name: 'cu.alias', rdev: 0x10000009n },
      { name: 'ttys009', rdev: 0x0f000009n }
    ]

    expect(await nameDarwinTerminals(darwinRow('16/9'), directory)).toBe(darwinRow('cu.alias'))
    expect(directory.openedPaths).toEqual(['/dev'])
  })

  it.each(['symlink', 'file'] as const)(
    'rejects a %s pty candidate and falls back to a character device',
    async (kind) => {
      const directory = new TestDeviceDirectory()
      directory.entries = [
        { name: 'ttys009', rdev: 0x10000009n, kind },
        { name: 'cu.real', rdev: 0x10000009n }
      ]

      expect(await nameDarwinTerminals(darwinRow('16/9'), directory)).toBe(darwinRow('cu.real'))
      expect(directory.openedPaths).toEqual(['/dev'])
    }
  )

  it('falls back when the pty candidate stat rejects', async () => {
    const directory = new TestDeviceDirectory()
    directory.entries = [
      { name: 'ttys009', rdev: 0x10000009n, error: new Error('EIO') },
      { name: 'cu.real', rdev: 0x10000009n }
    ]

    expect(await nameDarwinTerminals(darwinRow('16/9'), directory)).toBe(darwinRow('cu.real'))
  })

  it('falls back when the pty candidate stat throws synchronously', async () => {
    const directory = new TestDeviceDirectory()
    directory.entries = [
      { name: 'ttys009', rdev: 0x10000009n },
      { name: 'cu.real', rdev: 0x10000009n }
    ]
    const deps = {
      openDirectory: directory.openDirectory,
      readDevice: (path: string) => {
        if (path === join('/dev', 'ttys009')) {
          throw new Error('stat invocation failed')
        }
        return directory.readDevice(path)
      }
    }

    expect(await nameDarwinTerminals(darwinRow('16/9'), deps)).toBe(darwinRow('cu.real'))
  })

  it('scans only for unresolved devices and stops once they resolve', async () => {
    const directory = new TestDeviceDirectory()
    directory.entries = [
      { name: 'console', rdev: 0n },
      { name: 'ttys001', rdev: 0x10000001n },
      { name: 'ttys002', rdev: 0x10000002n },
      { name: 'later', rdev: 0x1600002an }
    ]
    const capture = ['16/1', '16/2', '0/0'].map((device) => darwinRow(device)).join('')

    expect(await nameDarwinTerminals(capture, directory)).toBe(
      ['ttys001', 'ttys002', 'console'].map((device) => darwinRow(device)).join('')
    )
    expect(directory.openedPaths).toEqual(['/dev'])
    expect(directory.readPaths).toEqual(
      ['ttys001', 'ttys002', 'ttys000', 'console'].map((name) => join('/dev', name))
    )
  })

  it('stops candidate stats after cancellation and rejects once the active read drains', async () => {
    const directory = new TestDeviceDirectory()
    directory.entries = [1, 2, 3].map((minor) => ({
      name: `ttys00${minor}`,
      rdev: 0x10000000n + BigInt(minor),
      delayMs: 10
    }))
    const capture = ['16/1', '16/2', '16/3'].map((device) => darwinRow(device)).join('')
    const controller = new AbortController()
    vi.useFakeTimers()
    const named = nameDarwinTerminals(capture, directory, controller.signal)
    let settled = false
    void named.then(
      () => (settled = true),
      () => (settled = true)
    )
    const rejection = expect(named).rejects.toThrow()
    // Cleanup awaits this too if an earlier assertion fails.
    void rejection.catch(() => {})
    try {
      await vi.advanceTimersByTimeAsync(2)
      expect(directory.readPaths).toEqual([join('/dev', 'ttys001')])
      controller.abort()
      await vi.advanceTimersByTimeAsync(0)
      expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(8)
      expect(directory.readPaths).toEqual([join('/dev', 'ttys001')])
      await rejection

      expect(directory.openedPaths).toEqual([])
      expect(directory.peakReads).toBe(1)
    } finally {
      controller.abort()
      try {
        await vi.runAllTimersAsync()
        await rejection.catch(() => {})
      } finally {
        vi.useRealTimers()
      }
    }
  })

  it('admits one device read at a time across candidate and scan phases', async () => {
    const directory = new TestDeviceDirectory()
    directory.entries = [
      ...Array.from({ length: 10 }, (_, minor) => ({
        name: `ttys00${minor}`,
        rdev: 0x10000000n + BigInt(minor),
        delayMs: 1
      })),
      { name: 'cu.serial', rdev: 0x1600002an, delayMs: 1 }
    ]
    const devices = [...Array.from({ length: 10 }, (_, minor) => `16/${minor}`), '22/42']

    expect(
      await nameDarwinTerminals(devices.map((device) => darwinRow(device)).join(''), directory)
    ).toBe(directory.entries.map((entry) => darwinRow(entry.name)).join(''))
    expect(directory.peakReads).toBe(1)
    expect(directory.openedPaths).toEqual(['/dev'])
  })

  it('accepts a four-digit pty candidate only when its device matches', async () => {
    const directory = new TestDeviceDirectory()
    directory.entries = [{ name: 'ttys1000', rdev: 0x100003e8n }]
    expect(await nameDarwinTerminals(darwinRow('16/1000'), directory)).toBe(darwinRow('ttys1000'))
    expect(directory.openedPaths).toEqual([])

    directory.entries = [{ name: 'ttys1000', rdev: 0x0f0003e8n }]
    expect(await nameDarwinTerminals(darwinRow('16/1000'), directory)).toBe(darwinRow('??'))
    expect(directory.openedPaths).toEqual(['/dev'])
  })

  it('looks up each distinct device once across repeated rows', async () => {
    const directory = new TestDeviceDirectory()
    directory.entries = [
      { name: 'ttys009', rdev: 0x10000009n },
      { name: 'ttys010', rdev: 0x1000000an }
    ]
    const capture = Array.from({ length: 50 }, () => darwinRow('16/9') + darwinRow('16/10')).join(
      ''
    )

    expect(await nameDarwinTerminals(capture, directory)).toBe(
      Array.from({ length: 50 }, () => darwinRow('ttys009') + darwinRow('ttys010')).join('')
    )
    expect(directory.readPaths).toEqual([join('/dev', 'ttys009'), join('/dev', 'ttys010')])
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
