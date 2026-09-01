import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Wraps the real `readdir` so the walk's concurrency is observable without
// changing what it reads.
const readdirCalls = vi.hoisted(() => ({ outstanding: 0, peak: 0, count: 0 }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  const realReaddir = actual.readdir as (...args: unknown[]) => Promise<never>
  return {
    ...actual,
    readdir: async (...args: unknown[]) => {
      readdirCalls.outstanding += 1
      readdirCalls.count += 1
      readdirCalls.peak = Math.max(readdirCalls.peak, readdirCalls.outstanding)
      try {
        return await realReaddir(...args)
      } finally {
        readdirCalls.outstanding -= 1
      }
    }
  }
})

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
  vi.restoreAllMocks()
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

  it('never has more than one directory read outstanding', async () => {
    // libuv's filesystem thread pool has four slots shared with the whole main
    // process. A probe that fanned out would stall unrelated fs work, so this
    // pins the walk as strictly sequential rather than merely bounded.
    const refs = await makeRefsTree({
      'remotes/a': 3,
      'remotes/b': 3,
      'remotes/c': 3,
      'remotes/d': 3,
      'remotes/e/deep': 3
    })
    readdirCalls.peak = 0
    readdirCalls.count = 0

    await countLooseRefs(refs, 1000)

    expect(readdirCalls.count).toBeGreaterThan(1)
    expect(readdirCalls.peak).toBe(1)
  })

  it('reads each directory once rather than streaming it in batches', async () => {
    // One thread-pool round trip per directory is what makes the probe ~8x
    // cheaper than the streaming form on a real degraded repository.
    const refs = await makeRefsTree({ 'remotes/origin': 400 })
    readdirCalls.count = 0

    await countLooseRefs(refs, 1000)

    // refs/ plus refs/remotes plus refs/remotes/origin.
    expect(readdirCalls.count).toBe(3)
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
