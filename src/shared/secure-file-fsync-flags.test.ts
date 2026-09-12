import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { removeTreeSync } from './windows-transient-lock-removal'
import type * as NodeFs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const openedPaths = vi.hoisted(
  () => [] as { path: string; flags: string | number; ownerWritable: boolean }[]
)

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof NodeFs>('node:fs')
  return {
    ...actual,
    openSync: (path: NodeFs.PathLike, flags: string | number, mode?: NodeFs.Mode) => {
      openedPaths.push({
        path: String(path),
        flags,
        ownerWritable: Boolean(actual.statSync(path).mode & 0o200)
      })
      return actual.openSync(path, flags, mode)
    }
  }
})

import {
  bestEffortFsyncDirectorySync,
  fsyncFileSync,
  writeDurableSecureJsonFile
} from './secure-file'

const createdPaths: string[] = []

afterEach(() => {
  openedPaths.length = 0
  for (const path of createdPaths.splice(0)) {
    removeTreeSync(path)
  }
})

describe('secure file fsync flags', () => {
  const windowsIt = process.platform === 'win32' ? it : it.skip
  windowsIt('opens files read/write before fsync on Windows', () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-file-fsync-'))
    createdPaths.push(directory)
    const path = join(directory, 'record.json')
    writeFileSync(path, '{}')

    fsyncFileSync(path)

    expect(openedPaths).toMatchObject([{ path, flags: 'r+' }])
  })

  const posixIt = process.platform === 'win32' ? it.skip : it
  posixIt('fsyncs files without owner-write permission', () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-file-fsync-read-only-'))
    createdPaths.push(directory)
    const path = join(directory, 'record.json')
    writeFileSync(path, '{}')
    chmodSync(path, 0o400)

    expect(() => fsyncFileSync(path)).not.toThrow()
    expect(openedPaths).toEqual([{ path, flags: 'r', ownerWritable: false }])
  })

  posixIt('durably writes when umask removes owner-write from the temporary file', () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-durable-file-fsync-read-only-'))
    createdPaths.push(directory)
    const path = join(directory, 'record.json')
    const originalUmask = process.umask(0o200)

    try {
      expect(() => writeDurableSecureJsonFile(path, { ok: true })).not.toThrow()
    } finally {
      process.umask(originalUmask)
    }

    expect(openedPaths[0]).toMatchObject({ flags: 'r', ownerWritable: false })
  })

  posixIt('opens directories read-only before fsync', () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-directory-fsync-'))
    createdPaths.push(directory)

    bestEffortFsyncDirectorySync(directory)

    expect(openedPaths).toMatchObject([{ path: directory, flags: 'r' }])
  })
})
