import type * as NodeFsPromises from 'node:fs/promises'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ restrict: vi.fn(), failure: '', calls: 0 }))
vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof NodeFsPromises>('node:fs/promises')
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const file = await actual.open(...args)
      if (args[1] === 'wx') {
        if (mocks.failure === 'sync') {
          vi.spyOn(file, 'sync').mockRejectedValue(new Error('fsync failed'))
        }
        if (mocks.failure === 'short') {
          const write = file.write.bind(file)
          return {
            write: async (buffer: Buffer, offset: number, length: number, position: number) => {
              mocks.calls++
              return write(buffer, offset, Math.min(length, 1), position)
            },
            sync: () => file.sync(),
            close: () => file.close()
          }
        }
      }
      return file
    }
  }
})
vi.mock('./secure-path-windows-acl', () => ({ restrictWindowsPath: mocks.restrict }))
import { writeProtectedFileAtomic } from './secure-file-publication'
let directory: string
let path: string
const operation = () => ({ deadline: Date.now() + 15_000, signal: new AbortController().signal })
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'orca-protected-publication-'))
  path = join(directory, 'vault')
  mocks.restrict.mockReset().mockResolvedValue(true)
  mocks.failure = ''
  mocks.calls = 0
})
afterEach(async () => {
  vi.restoreAllMocks()
  await rm(directory, { recursive: true, force: true })
})
it('publishes complete binary ciphertext with private permissions', async () => {
  const contents = Buffer.from([0, 255, 0, 128, 10])
  await writeProtectedFileAtomic(path, contents, operation())
  expect(await readFile(path)).toEqual(contents)
  expect((await stat(path)).mode & 0o777).toBe(0o600)
  expect((await stat(directory)).mode & 0o777).toBe(0o700)
})
it('does not replace existing ciphertext after cancellation', async () => {
  await writeFile(path, 'old')
  const controller = new AbortController()
  controller.abort()
  await expect(
    writeProtectedFileAtomic(path, Buffer.from('new'), {
      deadline: Date.now() + 1000,
      signal: controller.signal
    })
  ).rejects.toThrow()
  expect(await readFile(path, 'utf8')).toBe('old')
})
it.each([1, 2])('fails closed when protection step %i fails before publication', async (step) => {
  await writeFile(path, 'old')
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
  mocks.restrict.mockImplementation(async () => mocks.restrict.mock.calls.length !== step)
  await expect(writeProtectedFileAtomic(path, Buffer.from('new'), operation())).rejects.toThrow(
    'protection'
  )
  expect(await readFile(path, 'utf8')).toBe('old')
})
it('reports uncertain state if published ACL verification fails', async () => {
  await writeFile(path, 'old')
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
  mocks.restrict
    .mockResolvedValueOnce(true)
    .mockResolvedValueOnce(true)
    .mockResolvedValueOnce(false)
  await expect(writeProtectedFileAtomic(path, Buffer.from('new'), operation())).rejects.toThrow(
    'verify'
  )
  expect(await readFile(path, 'utf8')).toBe('new')
})

it('finishes short writes before publishing ciphertext', async () => {
  mocks.failure = 'short'
  await writeProtectedFileAtomic(path, Buffer.from('binary'), operation())
  expect(await readFile(path, 'utf8')).toBe('binary')
  expect(mocks.calls).toBe(6)
})
it('keeps the old file and cleans only its temporary file after fsync fails', async () => {
  await writeFile(path, 'old')
  await writeFile(join(directory, 'other.tmp'), 'unrelated')
  mocks.failure = 'sync'
  await expect(writeProtectedFileAtomic(path, Buffer.from('new'), operation())).rejects.toThrow(
    'fsync failed'
  )
  expect(await readFile(path, 'utf8')).toBe('old')
  expect((await readdir(directory)).sort()).toEqual(['other.tmp', 'vault'])
})
