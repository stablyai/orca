import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createFileContentCache } from './runtime-environment-store-read-cache'

let dir: string
let files: { path: string; maxBytes: number }[]
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-env-cache-'))
  files = [
    { path: join(dir, 'store.json'), maxBytes: 1024 },
    { path: join(dir, 'sidecar.json'), maxBytes: 1024 }
  ]
  writeFileSync(files[0]!.path, '{"a":1}')
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('file content read cache', () => {
  it('reuses a read only while every file holds the same bytes', () => {
    const cache = createFileContentCache<{ calls: number }>()
    const read = vi.fn(() => ({ calls: read.mock.calls.length }))

    cache.read(dir, dir, files, read).calls = 99
    expect(cache.read(dir, dir, files, read)).toEqual({ calls: 1 })
    expect(read).toHaveBeenCalledTimes(1)

    // Same size, new bytes: what a stat signature on a coarse-timestamp filesystem could miss.
    writeFileSync(files[0]!.path, '{"a":2}')
    expect(cache.read(dir, dir, files, read)).toEqual({ calls: 2 })
    writeFileSync(files[1]!.path, '{}')
    expect(cache.read(dir, dir, files, read)).toEqual({ calls: 3 })
    expect(cache.read(dir, dir, files, read)).toEqual({ calls: 3 })
  })

  it.skipIf(process.platform === 'win32')('rereads after a permission change', () => {
    const cache = createFileContentCache<number>()
    const read = vi.fn(() => read.mock.calls.length)
    cache.read(dir, dir, files, read)
    chmodSync(files[0]!.path, 0o644)
    cache.read(dir, dir, files, read)
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('does not cache a failed read or an oversized file', () => {
    const cache = createFileContentCache<number>()
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
