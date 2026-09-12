import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createQuickOpenReaddirBudget,
  listQuickOpenFilesWithReaddir
} from './quick-open-readdir-walk'

const tempRoots: string[] = []

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-quick-open-budget-'))
  tempRoots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('quick-open readdir memory limits', () => {
  it('accepts the exact entry limit and rejects the next zero-file entry', async () => {
    const root = await makeRoot()
    await mkdir(join(root, 'a'))
    await mkdir(join(root, 'b'))

    await expect(
      listQuickOpenFilesWithReaddir(root, {
        budget: createQuickOpenReaddirBudget({ maxEntries: 2 })
      })
    ).resolves.toEqual([])

    await mkdir(join(root, 'c'))
    await expect(
      listQuickOpenFilesWithReaddir(root, {
        budget: createQuickOpenReaddirBudget({ maxEntries: 2 })
      })
    ).rejects.toThrow('File listing exceeded 2 entries')
  })

  it('caps retained directory paths even when the tree contains no files', async () => {
    const root = await makeRoot()
    await mkdir(join(root, 'a'))
    await mkdir(join(root, 'b'))

    await expect(
      listQuickOpenFilesWithReaddir(root, {
        budget: createQuickOpenReaddirBudget({ maxDirectories: 3 })
      })
    ).resolves.toEqual([])
    await expect(
      listQuickOpenFilesWithReaddir(root, {
        budget: createQuickOpenReaddirBudget({ maxDirectories: 2 })
      })
    ).rejects.toThrow('File listing exceeded 2 directories')
  })

  it('accepts the exact depth limit and rejects a deeper directory', async () => {
    const root = await makeRoot()
    await mkdir(join(root, 'a', 'b'), { recursive: true })

    await expect(
      listQuickOpenFilesWithReaddir(root, {
        budget: createQuickOpenReaddirBudget({ maxDepth: 2 })
      })
    ).resolves.toEqual([])
    await expect(
      listQuickOpenFilesWithReaddir(root, {
        budget: createQuickOpenReaddirBudget({ maxDepth: 1 })
      })
    ).rejects.toThrow('File listing exceeded depth 1')
  })

  it('bounds aggregate path storage without changing exact-boundary output', async () => {
    const root = await makeRoot()
    const fileName = 'a.ts'
    await writeFile(join(root, fileName), 'x')
    const exactPathCodeUnits = root.length + fileName.length * 2

    await expect(
      listQuickOpenFilesWithReaddir(root, {
        budget: createQuickOpenReaddirBudget({ maxPathCodeUnits: exactPathCodeUnits })
      })
    ).resolves.toEqual([fileName])
    await expect(
      listQuickOpenFilesWithReaddir(root, {
        budget: createQuickOpenReaddirBudget({ maxPathCodeUnits: exactPathCodeUnits - 1 })
      })
    ).rejects.toThrow(`File listing exceeded ${exactPathCodeUnits - 1} path code units`)
  })
})
