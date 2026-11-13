import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { nameDarwinTerminals } from './darwin-terminal-names'

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
})
