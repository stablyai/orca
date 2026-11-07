import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createFileSignatureCache,
  noteEnvironmentRegistryWrite
} from './runtime-environment-store-read-cache'

let dir: string | undefined
afterEach(() => {
  if (dir) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('file signature read cache', () => {
  it('reuses an unchanged read and rereads after any write, including a new file', () => {
    dir = mkdtempSync(join(tmpdir(), 'orca-env-cache-'))
    const store = join(dir, 'store.json')
    const missing = join(dir, 'sidecar.json')
    writeFileSync(store, '{"a":1}')
    const cache = createFileSignatureCache<{ calls: number }>()
    const read = vi.fn(() => ({ calls: read.mock.calls.length }))

    const first = cache.read(dir, [store, missing], read)
    first.calls = 99
    expect(cache.read(dir, [store, missing], read)).toEqual({ calls: 1 })
    expect(read).toHaveBeenCalledTimes(1)

    writeFileSync(store, '{"a":22}')
    cache.read(dir, [store, missing], read)
    writeFileSync(missing, '{}')
    cache.read(dir, [store, missing], read)
    expect(read).toHaveBeenCalledTimes(3)
  })

  it('rereads after an in-process write even when the file stat looks unchanged', () => {
    dir = mkdtempSync(join(tmpdir(), 'orca-env-cache-'))
    const cache = createFileSignatureCache<number>()
    const read = vi.fn(() => read.mock.calls.length)
    cache.read(dir, [join(dir, 'missing.json')], read)
    noteEnvironmentRegistryWrite()
    cache.read(dir, [join(dir, 'missing.json')], read)
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('does not cache a failed read', () => {
    dir = mkdtempSync(join(tmpdir(), 'orca-env-cache-'))
    const cache = createFileSignatureCache<number>()
    const read = vi
      .fn<() => number>()
      .mockImplementationOnce(() => {
        throw new Error('invalid')
      })
      .mockReturnValue(1)
    expect(() => cache.read(dir!, [join(dir!, 'x')], read)).toThrow('invalid')
    expect(cache.read(dir, [join(dir, 'x')], read)).toBe(1)
  })
})
