import { cp, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { copyPath } from './copy-path'

const originalPlatform = process.platform
let root = ''

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
}

async function snapshot(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true })
  return Promise.all(
    entries.map(async (entry) => {
      const full = path.join(entry.parentPath, entry.name)
      const rel = path.relative(dir, full)
      return entry.isDirectory() ? `${rel}/` : `${rel}=${await readFile(full, 'utf8')}`
    })
  ).then((rows) => rows.sort())
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'copy-path-'))
  await mkdir(path.join(root, 'src', 'nested', 'deep'), { recursive: true })
  await mkdir(path.join(root, 'src', '.git'))
  await writeFile(path.join(root, 'src', 'top.txt'), 'top')
  await writeFile(path.join(root, 'src', 'nested', 'deep', 'leaf.txt'), 'leaf')
  await writeFile(path.join(root, 'src', '.git', 'HEAD'), 'ref')
})

afterEach(async () => {
  setPlatform(originalPlatform)
  await rm(root, { recursive: true, force: true })
})

describe('copyPath on Windows', () => {
  it('copies the same tree as fs.cp and keeps its errors', async () => {
    const source = path.join(root, 'src')
    const options = { recursive: true, filter: (from: string) => path.basename(from) !== '.git' }
    await cp(source, path.join(root, 'expected'), options)
    setPlatform('win32')

    await copyPath(source, path.join(root, 'actual'), options)
    expect(await snapshot(path.join(root, 'actual'))).toEqual(
      await snapshot(path.join(root, 'expected'))
    )

    await expect(
      copyPath(source, path.join(root, 'actual'), {
        recursive: true,
        errorOnExist: true,
        force: false
      })
    ).rejects.toMatchObject({ code: 'ERR_FS_CP_EEXIST' })
    await expect(
      copyPath(source, path.join(source, 'nested', 'inside'), { recursive: true })
    ).rejects.toMatchObject({ code: 'ERR_FS_CP_EINVAL' })
    await expect(
      copyPath(path.join(root, 'missing'), path.join(root, 'out'), { recursive: true })
    ).rejects.toMatchObject({ code: 'ENOENT' })

    await writeFile(path.join(source, 'top.txt'), 'changed')
    await copyPath(source, path.join(root, 'actual'), { recursive: true })
    expect(await readFile(path.join(root, 'actual', 'top.txt'), 'utf8')).toBe('changed')

    await symlink(source, path.join(root, 'alias'), 'junction')
    await expect(
      copyPath(source, path.join(root, 'alias', 'out'), { recursive: true })
    ).rejects.toMatchObject({ code: 'ERR_FS_CP_EINVAL' })
  })
})
