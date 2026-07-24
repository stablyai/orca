import { describe, expect, it } from 'vitest'
import { scanWorkspaceSpaceEntryTree } from './workspace-space-entry-traversal'
import { WorkspaceSpaceScanCapacityError } from './workspace-space-scan-budget'

type Entry = { name: string }

function makeTraversal(
  directories: ReadonlyMap<string, readonly Entry[]>,
  classifyEntry: (path: string) => Promise<{
    kind: 'directory' | 'file' | 'symlink'
    sizeBytes: number
  }>,
  limits?: { maxEntries?: number; maxRetainedBytes?: number }
) {
  return scanWorkspaceSpaceEntryTree({
    rootPath: '/root',
    rootName: 'root',
    concurrency: 5,
    entryName: (entry: Entry) => entry.name,
    joinPath: (parent, child) => `${parent}/${child}`,
    classifyEntry: (path) => classifyEntry(path),
    readDirectory: async (path) => {
      const entries = directories.get(path)
      if (!entries) {
        throw new Error(`unreadable ${path}`)
      }
      return entries
    },
    checkCancelled: () => undefined,
    createCancellationError: () => new Error('cancelled'),
    isCancellationError: (error) => error instanceof Error && error.message === 'cancelled',
    limits
  })
}

describe('scanWorkspaceSpaceEntryTree', () => {
  it('uses a fixed worker pool and preserves source order', async () => {
    const entries = Array.from({ length: 200 }, (_, index) => ({ name: `file-${index}` }))
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let active = 0
    let peak = 0
    let started = 0
    let saturated!: () => void
    const saturation = new Promise<void>((resolve) => {
      saturated = resolve
    })

    const scan = makeTraversal(new Map([['/root', entries]]), async (path) => {
      if (path === '/root') {
        return { kind: 'directory', sizeBytes: 1 }
      }
      active += 1
      started += 1
      peak = Math.max(peak, active)
      if (started === 5) {
        saturated()
      }
      await gate
      active -= 1
      return { kind: 'file', sizeBytes: 1 }
    })

    await saturation
    expect(started).toBe(5)
    expect(peak).toBe(5)
    release()

    const result = await scan
    expect(result.children?.map((child) => child.name)).toEqual(entries.map((entry) => entry.name))
    expect(result.sizeBytes).toBe(201)
  })

  it('preserves aggregate sizes and partial-failure accounting', async () => {
    const directories = new Map<string, readonly Entry[]>([
      ['/root', [{ name: 'directory' }, { name: 'missing' }, { name: 'link' }, { name: 'file' }]],
      ['/root/directory', [{ name: 'nested' }, { name: 'unreadable' }]],
      ['/root/directory/unreadable', []]
    ])
    directories.delete('/root/directory/unreadable')

    const result = await makeTraversal(directories, async (path) => {
      if (path === '/root') {
        return { kind: 'directory', sizeBytes: 10 }
      }
      if (path === '/root/directory') {
        return { kind: 'directory', sizeBytes: 5 }
      }
      if (path === '/root/directory/nested') {
        return { kind: 'file', sizeBytes: 100 }
      }
      if (path === '/root/directory/unreadable') {
        return { kind: 'directory', sizeBytes: 7 }
      }
      if (path === '/root/missing') {
        throw new Error('missing')
      }
      if (path === '/root/link') {
        return { kind: 'symlink', sizeBytes: 2 }
      }
      return { kind: 'file', sizeBytes: 20 }
    })

    expect(result).toMatchObject({ sizeBytes: 144, skippedEntryCount: 2 })
    expect(result.children?.map((child) => child.name)).toEqual(['directory', 'link', 'file'])
    expect(result.children?.[0]).toMatchObject({
      sizeBytes: 112,
      skippedEntryCount: 1
    })
  })

  it('accepts the exact entry cap without changing order or totals', async () => {
    const entries = [{ name: 'first' }, { name: 'second' }]
    const result = await makeTraversal(
      new Map([['/root', entries]]),
      async (path) => ({ kind: path === '/root' ? 'directory' : 'file', sizeBytes: 1 }),
      { maxEntries: entries.length }
    )

    expect(result.children?.map((child) => child.name)).toEqual(['first', 'second'])
    expect(result.sizeBytes).toBe(3)
  })

  it('fails closed instead of retaining entries beyond the scan cap', async () => {
    const entries = [{ name: 'first' }, { name: 'second' }, { name: 'overflow' }]
    const scan = makeTraversal(
      new Map([['/root', entries]]),
      async (path) => ({ kind: path === '/root' ? 'directory' : 'file', sizeBytes: 1 }),
      { maxEntries: entries.length - 1 }
    )

    await expect(scan).rejects.toBeInstanceOf(WorkspaceSpaceScanCapacityError)
  })

  it('aggregates a deep chain exactly at the entry cap without recursive unwinding', async () => {
    const depth = 256
    const directories = new Map<string, readonly Entry[]>()
    let path = '/root'
    for (let index = 0; index < depth; index += 1) {
      const name = `directory-${index}`
      directories.set(path, [{ name }])
      path = `${path}/${name}`
    }
    directories.set(path, [])

    const result = await makeTraversal(
      directories,
      async () => ({ kind: 'directory', sizeBytes: 1 }),
      { maxEntries: depth }
    )

    expect(result.sizeBytes).toBe(depth + 1)
    expect(result.children).toEqual([
      expect.objectContaining({ name: 'directory-0', sizeBytes: depth })
    ])
  })

  it('fails closed when a deep chain crosses the cumulative entry cap', async () => {
    const directories = new Map<string, readonly Entry[]>()
    let path = '/root'
    for (let index = 0; index < 5; index += 1) {
      const name = `directory-${index}`
      directories.set(path, [{ name }])
      path = `${path}/${name}`
    }
    directories.set(path, [])

    const scan = makeTraversal(directories, async () => ({ kind: 'directory', sizeBytes: 1 }), {
      maxEntries: 4
    })

    await expect(scan).rejects.toBeInstanceOf(WorkspaceSpaceScanCapacityError)
  })
})
