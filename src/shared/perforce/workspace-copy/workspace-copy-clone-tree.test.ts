import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cloneTree } from './workspace-copy-clone-tree'

let base: string

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'p4clone-'))
})

afterEach(async () => {
  await rm(base, { recursive: true, force: true })
})

// copyMode 0 is a plain copy: test volumes need not clone; the walk, exclusions and times are the same.
describe('cloneTree', () => {
  it('leaves out excluded folders and files and keeps file and folder times', async () => {
    const source = join(base, 'ws')
    const library = join(source, 'Game', 'Library')
    await mkdir(join(source, 'Game', 'Temp'), { recursive: true })
    await mkdir(join(source, 'Game', 'Assets', 'Temp'), { recursive: true })
    await mkdir(library, { recursive: true })
    await writeFile(join(source, 'Game', 'Temp', 'state'), 'x')
    await writeFile(join(source, 'Game', 'Assets', 'Temp', 'kept.txt'), 'kept')
    await writeFile(join(library, 'ArtifactDB'), 'db')
    await writeFile(join(library, 'ArtifactDB-lock'), 'lock')
    const old = new Date('2024-01-02T03:04:05Z')
    await utimes(join(library, 'ArtifactDB'), old, old)
    await utimes(library, old, old)

    const destination = join(base, 'ws.wt', 'one')
    const result = await cloneTree(
      source,
      destination,
      { folders: [join(source, 'Game', 'Temp')], files: [join(library, 'ArtifactDB-lock')] },
      0
    )

    expect(result).toEqual({ ok: true, files: 2, bytes: 6, cloned: null })
    expect(existsSync(join(destination, 'Game', 'Temp'))).toBe(false)
    expect(existsSync(join(destination, 'Game', 'Library', 'ArtifactDB-lock'))).toBe(false)
    expect(existsSync(join(destination, 'Game', 'Assets', 'Temp', 'kept.txt'))).toBe(true)
    const copiedLibrary = join(destination, 'Game', 'Library')
    expect((await stat(join(copiedLibrary, 'ArtifactDB'))).mtimeMs).toBe(old.getTime())
    expect((await stat(copiedLibrary)).mtimeMs).toBe(old.getTime())
  })
})
