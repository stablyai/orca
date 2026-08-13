import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type * as NodeFs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const openedPaths = vi.hoisted(() => [] as { path: string; flags: string | number }[])

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof NodeFs>('node:fs')
  return {
    ...actual,
    openSync: (path: NodeFs.PathLike, flags: string | number, mode?: NodeFs.Mode) => {
      openedPaths.push({ path: String(path), flags })
      return actual.openSync(path, flags, mode)
    }
  }
})

import { bestEffortFsyncDirectorySync, fsyncFileSync } from './secure-file'

const createdPaths: string[] = []

afterEach(() => {
  openedPaths.length = 0
  for (const path of createdPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
})

describe('secure file fsync flags', () => {
  it('opens files read/write before fsync', () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-file-fsync-'))
    createdPaths.push(directory)
    const path = join(directory, 'record.json')
    writeFileSync(path, '{}')

    fsyncFileSync(path)

    expect(openedPaths).toEqual([{ path, flags: 'r+' }])
  })

  const posixIt = process.platform === 'win32' ? it.skip : it
  posixIt('opens directories read-only before fsync', () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-directory-fsync-'))
    createdPaths.push(directory)

    bestEffortFsyncDirectorySync(directory)

    expect(openedPaths).toEqual([{ path: directory, flags: 'r' }])
  })
})
