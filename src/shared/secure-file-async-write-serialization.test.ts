// The async lane's contract, which the synchronous twin got for free: the durability syscalls keep
// their pinned order, and two writers racing on one destination cannot interleave their temp-file
// dances onto it.
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import type * as NodeFsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

type Step = 'fsync:file' | 'fsync:directory' | 'rename' | 'write'
const steps = vi.hoisted(() => [] as Step[])

// secure-file opens through fs/promises only to fsync, so the open is the fsync for ordering.
vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof NodeFsPromises>('node:fs/promises')
  return {
    ...actual,
    open: async (path: string, flags: string) => {
      steps.push(statSync(path).isDirectory() ? 'fsync:directory' : 'fsync:file')
      return await actual.open(path, flags)
    },
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      steps.push('write')
      return await actual.writeFile(...args)
    },
    rename: async (...args: Parameters<typeof actual.rename>) => {
      steps.push('rename')
      return await actual.rename(...args)
    }
  }
})

import { pendingPathWriteCountForTests } from './path-write-serializer'
import { writeSecureFileAsync } from './secure-file-async-write'

const directories: string[] = []

afterEach(() => {
  steps.length = 0
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function freshDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix))
  directories.push(directory)
  return directory
}

const posixIt = process.platform === 'win32' ? it.skip : it

posixIt('keeps the file fsync before the rename and the directory fsync after it', async () => {
  const directory = freshDirectory('orca-secure-async-order-')
  const target = join(directory, 'secret.json')

  await writeSecureFileAsync(target, '{"ok":1}', { durable: true })

  expect(readFileSync(target, 'utf-8')).toBe('{"ok":1}')
  // Publishing the name before the data fsync is what lets a crash expose a zero-length credential.
  expect(steps).toEqual(['write', 'fsync:file', 'rename', 'fsync:directory'])
})

posixIt('serializes concurrent writes to one target instead of interleaving them', async () => {
  const directory = freshDirectory('orca-secure-async-race-')
  const target = join(directory, 'secret.json')
  // Distinct and large enough that a torn write would resemble neither payload.
  const first = JSON.stringify({ who: 'first', pad: 'a'.repeat(256 * 1024) })
  const second = JSON.stringify({ who: 'second', pad: 'b'.repeat(256 * 1024) })

  await Promise.all([
    writeSecureFileAsync(target, first, { durable: true }),
    writeSecureFileAsync(target, second, { durable: true })
  ])

  // One complete payload, never a mix: a reader of a credential file cannot detect a blend.
  expect([first, second]).toContain(readFileSync(target, 'utf-8'))
  // Two whole dances back to back, not two interleaved ones.
  expect(steps).toEqual([
    'write',
    'fsync:file',
    'rename',
    'fsync:directory',
    'write',
    'fsync:file',
    'rename',
    'fsync:directory'
  ])
  expect(readdirSync(directory)).toEqual(['secret.json'])
})

posixIt('releases the per-path lane once the writes settle', async () => {
  const directory = freshDirectory('orca-secure-async-lane-')
  const before = pendingPathWriteCountForTests()

  await Promise.all([
    writeSecureFileAsync(join(directory, 'a.json'), 'a'),
    writeSecureFileAsync(join(directory, 'b.json'), 'b')
  ])

  // The lane map is keyed per path, so a leak here is an unbounded per-file leak.
  expect(pendingPathWriteCountForTests()).toBe(before)
})

posixIt('removes the temp file when the write cannot be published', async () => {
  const directory = freshDirectory('orca-secure-async-fail-')
  // A directory standing where the file belongs makes the rename fail after the temp write landed.
  const target = join(directory, 'blocked')
  mkdirSync(join(target, 'occupied'), { recursive: true })

  await expect(writeSecureFileAsync(target, 'x')).rejects.toThrow()

  expect(readdirSync(directory)).toEqual(['blocked'])
})
