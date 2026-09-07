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
  limits?: { maxEntries?: number; maxRetainedBytes?: number },
  concurrency = 5
) {
  return scanWorkspaceSpaceEntryTree({
    rootPath: '/root',
    rootName: 'root',
    concurrency,
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

  it('scans a chain far longer than the cap because listings are released', async () => {
    const depth = 50
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
      { maxEntries: 4 }
    )

    expect(result.sizeBytes).toBe(depth + 1)
  })

  it('still fails closed when one directory holds more entries than the cap', async () => {
    const entries = Array.from({ length: 12 }, (_, index) => ({ name: `entry-${index}` }))
    const scan = makeTraversal(
      new Map([['/root', entries]]),
      async (path) => ({ kind: path === '/root' ? 'directory' : 'file', sizeBytes: 1 }),
      { maxEntries: 4 }
    )

    await expect(scan).rejects.toBeInstanceOf(WorkspaceSpaceScanCapacityError)
  })

  // Why: a cap N workers can each charge scales the verdict with concurrency,
  // which docs/workspace-space-scan-resource-bounds.md forbids.
  describe('capacity depends on directory shape, not tree size or concurrency', () => {
    function buildWideTree(dirCount: number, filesPerDir: number) {
      const directories = new Map<string, readonly Entry[]>()
      directories.set(
        '/root',
        Array.from({ length: dirCount }, (_, index) => ({ name: `dir-${index}` }))
      )
      for (let index = 0; index < dirCount; index += 1) {
        directories.set(
          `/root/dir-${index}`,
          Array.from({ length: filesPerDir }, (_, file) => ({ name: `file-${file}` }))
        )
      }
      return directories
    }

    function scanWideTree(dirCount: number, filesPerDir: number, concurrency: number) {
      const directories = buildWideTree(dirCount, filesPerDir)
      return makeTraversal(
        directories,
        async (path) => ({
          kind: directories.has(path) ? 'directory' : 'file',
          sizeBytes: 1
        }),
        { maxEntries: 100_000, maxRetainedBytes: Number.MAX_SAFE_INTEGER },
        concurrency
      )
    }

    it.each([
      { dirCount: 48, filesPerDir: 2_100, concurrency: 48 },
      { dirCount: 100, filesPerDir: 1_500, concurrency: 48 },
      { dirCount: 10, filesPerDir: 10_001, concurrency: 10 },
      { dirCount: 40, filesPerDir: 2_500, concurrency: 48 }
    ])(
      'scans $dirCount x $filesPerDir at concurrency $concurrency',
      async ({ dirCount, filesPerDir, concurrency }) => {
        const result = await scanWideTree(dirCount, filesPerDir, concurrency)
        expect(result.sizeBytes).toBe(dirCount * filesPerDir + dirCount + 1)
        expect(result.skippedEntryCount).toBe(0)
      },
      30_000
    )

    it('still rejects a single directory above the cap', async () => {
      await expect(scanWideTree(1, 100_001, 48)).rejects.toBeInstanceOf(
        WorkspaceSpaceScanCapacityError
      )
    }, 30_000)
  })

  // Why: the cases above pin maxRetainedBytes open, so only these see the byte
  // cap — and its verdict must not depend on where the worktree is checked out.
  describe('capacity at the production default limits', () => {
    // A real worktree checkout path; the bug appeared above ~58 characters.
    const DEEP_ROOT = '/Users/octocat/projects/orca/.claude/worktrees/wf_d39acf3c-e7d-2'

    function scanAtDefaults(
      rootPath: string,
      dirCount: number,
      filesPerDir: number,
      concurrency: number
    ) {
      const directories = new Map<string, readonly Entry[]>()
      directories.set(
        rootPath,
        Array.from({ length: dirCount }, (_, index) => ({ name: `dir-${index}` }))
      )
      for (let index = 0; index < dirCount; index += 1) {
        directories.set(
          `${rootPath}/dir-${index}`,
          Array.from({ length: filesPerDir }, (_, file) => ({ name: `file-${file}.ts` }))
        )
      }
      return scanWorkspaceSpaceEntryTree({
        rootPath,
        rootName: 'root',
        concurrency,
        entryName: (entry: Entry) => entry.name,
        joinPath: (parent, child) => `${parent}/${child}`,
        classifyEntry: async (path) => ({
          kind: directories.has(path) ? ('directory' as const) : ('file' as const),
          sizeBytes: 1
        }),
        readDirectory: async (path) => {
          const entries = directories.get(path)
          if (!entries) {
            throw new Error(`unreadable ${path}`)
          }
          return entries
        },
        checkCancelled: () => undefined,
        createCancellationError: () => new Error('cancelled'),
        isCancellationError: (error) => error instanceof Error && error.message === 'cancelled'
      })
    }

    it.each([
      { dirCount: 48, filesPerDir: 2_100, concurrency: 48 },
      { dirCount: 10, filesPerDir: 10_001, concurrency: 10 },
      { dirCount: 40, filesPerDir: 2_500, concurrency: 48 }
    ])(
      'scans $dirCount x $filesPerDir at concurrency $concurrency under a deep root',
      async ({ dirCount, filesPerDir, concurrency }) => {
        const result = await scanAtDefaults(DEEP_ROOT, dirCount, filesPerDir, concurrency)
        expect(result.sizeBytes).toBe(dirCount * filesPerDir + dirCount + 1)
      },
      30_000
    )

    it('reaches the same verdict under a short root as under a deep one', async () => {
      const shallow = await scanAtDefaults('/w', 48, 2_100, 48)
      const deep = await scanAtDefaults(DEEP_ROOT, 48, 2_100, 48)

      expect(deep.sizeBytes).toBe(shallow.sizeBytes)
    }, 30_000)
  })
})
