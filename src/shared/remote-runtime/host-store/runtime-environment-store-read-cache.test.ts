import { chmodSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSecureFileContentCache } from './runtime-environment-store-read-cache'

let dir: string
let files: { path: string; maxBytes: number }[]
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-env-cache-'))
  files = [
    { path: join(dir, 'store.json'), maxBytes: 1024 },
    { path: join(dir, 'sidecar.json'), maxBytes: 1024 }
  ]
  writeFileSync(files[0]!.path, '{"a":1}', { mode: 0o600 })
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('file content read cache', () => {
  it('reuses a read only while every file holds the same bytes', () => {
    const cache = createSecureFileContentCache<{ calls: number }>()
    const read = vi.fn(() => ({ calls: read.mock.calls.length }))

    cache.read(dir, dir, files, read).calls = 99
    expect(cache.read(dir, dir, files, read)).toEqual({ calls: 1 })
    expect(read).toHaveBeenCalledTimes(1)

    // Same size, new bytes: what a stat signature on a coarse-timestamp filesystem could miss.
    writeFileSync(files[0]!.path, '{"a":2}')
    expect(cache.read(dir, dir, files, read)).toEqual({ calls: 2 })
    writeFileSync(files[1]!.path, '{}', { mode: 0o600 })
    expect(cache.read(dir, dir, files, read)).toEqual({ calls: 3 })
    expect(cache.read(dir, dir, files, read)).toEqual({ calls: 3 })
  })

  it.skipIf(process.platform === 'win32')('rereads after a permission change', () => {
    const cache = createSecureFileContentCache<number>()
    const read = vi.fn(() => read.mock.calls.length)
    cache.read(dir, dir, files, read)
    chmodSync(files[0]!.path, 0o644)
    cache.read(dir, dir, files, read)
    expect(read).toHaveBeenCalledTimes(2)
  })

  it.skipIf(process.platform === 'win32')(
    'keeps retrying until permissions are restricted, as the uncached read does',
    () => {
      const cache = createSecureFileContentCache<number>()
      const read = vi.fn(() => read.mock.calls.length)
      chmodSync(files[0]!.path, 0o644)
      cache.read(dir, dir, files, read)
      cache.read(dir, dir, files, read)
      expect(read).toHaveBeenCalledTimes(2)
      chmodSync(files[0]!.path, 0o600)
      cache.read(dir, dir, files, read)
      cache.read(dir, dir, files, read)
      expect(read).toHaveBeenCalledTimes(3)
    }
  )

  it.skipIf(process.platform === 'win32')(
    'does not pin a value read through a symlink re-pointed and restored mid-read',
    () => {
      const a = join(dir, 'a.json')
      const b = join(dir, 'b.json')
      writeFileSync(a, '"A"', { mode: 0o600 })
      writeFileSync(b, '"B"', { mode: 0o600 })
      const link = join(dir, 'link.json')
      const repoint = (target: string): void => {
        symlinkSync(target, `${link}.tmp`)
        renameSync(`${link}.tmp`, link)
      }
      repoint(a)
      const linked = [{ path: link, maxBytes: 1024 }]
      const cache = createSecureFileContentCache<string>()
      let racing = true
      const read = vi.fn(() => {
        if (!racing) {
          return 'A'
        }
        racing = false
        repoint(b)
        repoint(a)
        return 'B'
      })
      expect(cache.read(dir, dir, linked, read)).toBe('B')
      expect(cache.read(dir, dir, linked, read)).toBe('A')
      expect(cache.read(dir, dir, linked, read)).toBe('A')
      expect(read).toHaveBeenCalledTimes(2)
    }
  )

  it('does not cache a failed read or an oversized file', () => {
    const cache = createSecureFileContentCache<number>()
    const read = vi
      .fn<() => number>()
      .mockImplementationOnce(() => {
        throw new Error('invalid')
      })
      .mockReturnValue(1)
    expect(() => cache.read(dir, dir, files, read)).toThrow('invalid')
    expect(cache.read(dir, dir, files, read)).toBe(1)

    writeFileSync(files[0]!.path, 'x'.repeat(2048))
    cache.read(dir, dir, files, read)
    cache.read(dir, dir, files, read)
    expect(read).toHaveBeenCalledTimes(4)
  })
})
