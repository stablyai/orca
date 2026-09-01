import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { countLooseRefs } from './loose-ref-count'

const roots: string[] = []

async function makeRefsTree(counts: Record<string, number>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-loose-refs-'))
  roots.push(root)
  const refs = join(root, 'refs')
  for (const [namespace, count] of Object.entries(counts)) {
    const directory = join(refs, namespace)
    await mkdir(directory, { recursive: true })
    for (let index = 0; index < count; index += 1) {
      await writeFile(join(directory, `ref-${index}`), 'a'.repeat(40))
    }
  }
  await mkdir(refs, { recursive: true })
  return refs
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('countLooseRefs', () => {
  it('counts files across nested namespaces', async () => {
    const refs = await makeRefsTree({ heads: 3, 'remotes/origin': 4, 'remotes/fork/deep': 2 })

    await expect(countLooseRefs(refs, 100)).resolves.toEqual({ count: 9, saturated: false })
  })

  it('stops at the budget instead of walking the whole backlog', async () => {
    const refs = await makeRefsTree({ 'remotes/origin': 500 })

    const result = await countLooseRefs(refs, 10)

    expect(result).toEqual({ count: 10, saturated: true })
  })

  it('reports zero for a repository with no refs directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-loose-refs-missing-'))
    roots.push(root)

    await expect(countLooseRefs(join(root, 'refs'), 100)).resolves.toEqual({
      count: 0,
      saturated: false
    })
  })

  it('does not follow directory symlinks into a loop', async () => {
    const refs = await makeRefsTree({ heads: 2 })
    await symlink(refs, join(refs, 'loop'), 'dir')

    const result = await countLooseRefs(refs, 100)

    expect(result.saturated).toBe(false)
    // The symlink is one dirent, never a second traversal of the tree.
    expect(result.count).toBe(3)
  })
})
