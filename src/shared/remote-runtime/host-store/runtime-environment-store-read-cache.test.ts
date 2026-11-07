import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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

// Windows never reuses reads (ACLs are invisible to the snapshot), so there is no cache to exercise.
describe.skipIf(process.platform === 'win32')('secure file content cache', () => {
  it('computes from the bytes it keys on and reuses them only while they are unchanged', () => {
    const cache = createSecureFileContentCache<{ texts: (string | null)[] }>()
    const compute = vi.fn((texts: (string | null)[]) => ({ texts }))
    const fallback = vi.fn(() => ({ texts: [] }))
    const read = () => cache.read(dir, dir, files, compute, fallback)

    read().texts.push('mutated')
    expect(read()).toEqual({ texts: ['{"a":1}', null] })
    expect(compute).toHaveBeenCalledTimes(1)

    // Same size, new bytes: what a stat signature on a coarse-timestamp filesystem could miss.
    writeFileSync(files[0]!.path, '{"a":2}')
    expect(read()).toEqual({ texts: ['{"a":2}', null] })
    writeFileSync(files[1]!.path, '{}', { mode: 0o600 })
    expect(read()).toEqual({ texts: ['{"a":2}', '{}'] })
    expect(read()).toEqual({ texts: ['{"a":2}', '{}'] })
    expect(compute).toHaveBeenCalledTimes(3)
    expect(fallback).not.toHaveBeenCalled()
  })

  it('never caches a failed compute and uses the plain reader for an unreadable file', () => {
    const cache = createSecureFileContentCache<number>()
    const compute = vi
      .fn<() => number>()
      .mockImplementationOnce(() => {
        throw new Error('invalid')
      })
      .mockReturnValue(1)
    const fallback = vi.fn(() => 2)
    expect(() => cache.read(dir, dir, files, compute, fallback)).toThrow('invalid')
    expect(cache.read(dir, dir, files, compute, fallback)).toBe(1)

    writeFileSync(files[0]!.path, 'x'.repeat(2048))
    expect(cache.read(dir, dir, files, compute, fallback)).toBe(2)
    expect(cache.read(dir, dir, files, compute, fallback)).toBe(2)
    expect(compute).toHaveBeenCalledTimes(2)
  })
})
