import { afterEach, describe, expect, it, vi } from 'vitest'

const { lstatMock, readdirMock } = vi.hoisted(() => ({
  lstatMock: vi.fn(),
  readdirMock: vi.fn()
}))

vi.mock('fs/promises', async () => {
  const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises') // eslint-disable-line @typescript-eslint/consistent-type-imports -- vi.importActual requires inline import()
  lstatMock.mockImplementation(actual.lstat)
  readdirMock.mockImplementation(actual.readdir)
  return {
    ...actual,
    lstat: lstatMock,
    readdir: readdirMock
  }
})

import { mkdtemp, mkdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  classifyQuickOpenGitEntry,
  createQuickOpenReaddirBudget,
  expandQuickOpenGitFileListing,
  isQuickOpenReaddirBudgetError,
  listQuickOpenFilesWithReaddir,
  parseQuickOpenGitLsFilesEntry,
  QUICK_OPEN_READDIR_MAX_FILES
} from './quick-open-readdir-walk'
import { isFileListingCancellation } from './file-listing-cancellation'

const tempDirs: string[] = []
const SHA1 = '0123456789abcdef0123456789abcdef01234567'
const SHA256 = `${SHA1}89abcdef0123456789abcdef`

function staged(mode: string, path: string, sha = SHA1): string {
  return `${mode} ${sha} 0\t${path}`
}

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-quick-open-readdir-'))
  tempDirs.push(root)
  return root
}

async function writeRel(root: string, relPath: string, content = 'x'): Promise<void> {
  const absPath = join(root, ...relPath.split('/'))
  await mkdir(dirname(absPath), { recursive: true })
  await writeFile(absPath, content)
}

async function mkdirRel(root: string, relPath: string): Promise<void> {
  await mkdir(join(root, ...relPath.split('/')), { recursive: true })
}

async function makeNestedRepo(root: string, relPath: string, gitEntry: 'dir' | 'file' = 'dir') {
  await mkdirRel(root, relPath)
  const gitPath = join(root, ...relPath.split('/'), '.git')
  await (gitEntry === 'dir'
    ? mkdir(gitPath, { recursive: true })
    : writeFile(gitPath, 'gitdir: ../.git/worktrees/example'))
}

afterEach(async () => {
  vi.clearAllMocks()
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('quick-open readdir walk', () => {
  it('parses git ls-files stage output and bare untracked entries', () => {
    expect(parseQuickOpenGitLsFilesEntry(staged('100644', 'src/index.ts'))).toEqual({
      path: 'src/index.ts',
      isGitlink: false,
      isUntrackedDir: false
    })
    expect(parseQuickOpenGitLsFilesEntry(staged('160000', 'packages/app'))).toEqual({
      path: 'packages/app',
      isGitlink: true,
      isUntrackedDir: false
    })
    expect(parseQuickOpenGitLsFilesEntry(staged('100755', 'bin/run', SHA256))).toEqual({
      path: 'bin/run',
      isGitlink: false,
      isUntrackedDir: false
    })
    expect(parseQuickOpenGitLsFilesEntry('scratch.txt')).toEqual({
      path: 'scratch.txt',
      isGitlink: false,
      isUntrackedDir: false
    })
    expect(parseQuickOpenGitLsFilesEntry('packages/lib/')).toEqual({
      path: 'packages/lib/',
      isGitlink: false,
      isUntrackedDir: true
    })
  })

  it('keeps ordinary git entries without lstat calls', async () => {
    await expect(
      expandQuickOpenGitFileListing({
        rootPath: '/unused/root',
        gitPaths: [
          staged('100644', 'README.md'),
          staged('100755', 'bin/run', SHA256),
          'scratch.txt'
        ]
      })
    ).resolves.toEqual(['README.md', 'bin/run', 'scratch.txt'])

    expect(lstatMock).not.toHaveBeenCalled()
  })

  it('classifies nested repo placeholders without confusing extensionless files', async () => {
    const root = await makeTempRoot()
    await writeRel(root, 'Makefile')
    await makeNestedRepo(root, 'packages/app')
    await makeNestedRepo(root, 'packages/lib', 'file')
    await mkdirRel(root, 'packages/unchecked')

    await expect(classifyQuickOpenGitEntry(root, staged('100644', 'Makefile'))).resolves.toEqual({
      kind: 'keep',
      relPath: 'Makefile'
    })
    await expect(
      classifyQuickOpenGitEntry(root, staged('160000', 'packages/app'))
    ).resolves.toEqual({
      kind: 'fill-nested-repo',
      relPath: 'packages/app'
    })
    await expect(classifyQuickOpenGitEntry(root, 'packages/lib/')).resolves.toEqual({
      kind: 'fill-nested-repo',
      relPath: 'packages/lib'
    })
    await expect(classifyQuickOpenGitEntry(root, 'packages/unchecked')).resolves.toEqual({
      kind: 'keep',
      relPath: 'packages/unchecked'
    })
    await expect(classifyQuickOpenGitEntry(root, 'packages/unchecked/')).resolves.toEqual({
      kind: 'drop-placeholder',
      relPath: 'packages/unchecked'
    })
  })

  it('re-prefixes nested children and filters final workspace-relative paths', async () => {
    const root = await makeTempRoot()
    await writeRel(root, 'README.md')
    await writeRel(root, 'Makefile')
    await makeNestedRepo(root, 'packages/app')
    await makeNestedRepo(root, 'packages/lib', 'file')
    await mkdirRel(root, 'packages/empty')
    await writeRel(root, 'packages/app/src/main.ts')
    await writeRel(root, 'packages/app/node_modules/pkg/index.js')
    await writeRel(root, 'packages/app/.git/config')
    await writeRel(root, 'packages/app/linked-worktree/file.ts')
    await writeRel(root, 'packages/lib/src/lib.ts')

    await expect(
      expandQuickOpenGitFileListing({
        rootPath: root,
        gitPaths: [
          staged('100644', 'README.md'),
          staged('100644', 'Makefile'),
          staged('160000', 'packages/app'),
          'packages/lib/',
          'packages/empty/'
        ],
        excludePathPrefixes: ['packages/app/linked-worktree']
      })
    ).resolves.toEqual([
      'README.md',
      'Makefile',
      'packages/app/src/main.ts',
      'packages/lib/src/lib.ts'
    ])
  })

  it('rejects on cap and shares one budget across nested subtrees', async () => {
    const root = await makeTempRoot()
    await makeNestedRepo(root, 'packages/app')
    await makeNestedRepo(root, 'packages/lib')
    await writeRel(root, 'packages/app/a.ts')
    await writeRel(root, 'packages/app/b.ts')
    await writeRel(root, 'packages/lib/c.ts')

    await expect(
      expandQuickOpenGitFileListing({
        rootPath: root,
        gitPaths: [staged('160000', 'packages/app'), staged('160000', 'packages/lib')],
        budget: createQuickOpenReaddirBudget({ maxFiles: 2 })
      })
    ).rejects.toThrow('File listing exceeded')
  })

  it('prunes excluded nested subtrees during traversal without consuming the budget', async () => {
    const root = await makeTempRoot()
    await makeNestedRepo(root, 'packages/app')
    await writeRel(root, 'packages/app/keep.ts')
    // A large excluded subtree inside the nested repo: if it were walked before
    // being filtered, it would exhaust the tiny budget and reject.
    for (let i = 0; i < 20; i += 1) {
      await writeRel(root, `packages/app/excluded/file-${i}.ts`)
    }

    await expect(
      expandQuickOpenGitFileListing({
        rootPath: root,
        gitPaths: [staged('160000', 'packages/app')],
        excludePathPrefixes: ['packages/app/excluded'],
        budget: createQuickOpenReaddirBudget({ maxFiles: 5 })
      })
    ).resolves.toEqual(['packages/app/keep.ts'])
  })

  it('expands allowed ignored directories without walking blocked or excluded directories', async () => {
    const root = await makeTempRoot()
    await writeRel(root, 'dist/generated.js')
    await writeRel(root, 'node_modules/pkg/index.js')
    await writeRel(root, '.cache/state.json')
    await writeRel(root, '.local/share/state.json')
    await writeRel(root, '.local/config.toml')
    await writeRel(root, 'excluded/other.js')

    await expect(
      expandQuickOpenGitFileListing({
        rootPath: root,
        gitPaths: [],
        directoryPaths: [
          'dist/',
          '.local/',
          'node_modules/',
          '.cache/',
          '.local/share/',
          'excluded/'
        ],
        excludePathPrefixes: ['excluded'],
        budget: createQuickOpenReaddirBudget({ maxFiles: 2 })
      })
    ).resolves.toEqual(['.local/config.toml', 'dist/generated.js'])

    const walkedPaths = readdirMock.mock.calls.map(([path]) => path)
    expect(walkedPaths).toContain(join(root, 'dist'))
    expect(walkedPaths).toContain(join(root, '.local'))
    expect(walkedPaths).not.toContain(join(root, '.local', 'share'))
  })

  it('batches many allowed directory placeholders with bounded concurrency', async () => {
    const root = await makeTempRoot()
    const directoryPaths = Array.from({ length: 40 }, (_, index) => `generated-${index}/`)
    await Promise.all(
      directoryPaths.map((directoryPath, index) =>
        writeRel(root, `${directoryPath}file-${index}.ts`)
      )
    )

    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises') // eslint-disable-line @typescript-eslint/consistent-type-imports -- vi.importActual requires inline import()
    let activeReads = 0
    let maxActiveReads = 0
    readdirMock.mockImplementation(async (...args: Parameters<typeof actual.readdir>) => {
      activeReads++
      maxActiveReads = Math.max(maxActiveReads, activeReads)
      await new Promise((resolve) => setTimeout(resolve, 5))
      try {
        return await actual.readdir(...args)
      } finally {
        activeReads--
      }
    })

    try {
      const files = await expandQuickOpenGitFileListing({
        rootPath: root,
        gitPaths: [],
        directoryPaths
      })
      expect(files).toHaveLength(directoryPaths.length)
      expect(maxActiveReads).toBeGreaterThan(1)
      expect(maxActiveReads).toBeLessThanOrEqual(32)
    } finally {
      readdirMock.mockImplementation(actual.readdir)
    }
  })

  it('preserves symlink leaves from collapsed Git directories without following them', async () => {
    const root = await makeTempRoot()
    await mkdirRel(root, 'scratch')
    await writeRel(root, 'target/file.ts')

    try {
      await symlink(join(root, 'target', 'file.ts'), join(root, 'scratch', 'link.ts'))
      await symlink(join(root, 'target'), join(root, 'scratch', 'linked-dir'), 'dir')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EPERM') {
        return
      }
      throw err
    }

    await expect(
      expandQuickOpenGitFileListing({
        rootPath: root,
        gitPaths: [],
        directoryPaths: ['scratch/']
      })
    ).resolves.toEqual(['scratch/link.ts', 'scratch/linked-dir'])
  })

  it('does not follow a collapsed directory replaced by a symlink', async () => {
    const root = await makeTempRoot()
    const outsideRoot = await makeTempRoot()
    await writeRel(outsideRoot, 'secret.ts')

    try {
      await symlink(outsideRoot, join(root, 'dist'), 'dir')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EPERM') {
        return
      }
      throw err
    }

    await expect(
      expandQuickOpenGitFileListing({
        rootPath: root,
        gitPaths: [],
        directoryPaths: ['dist/']
      })
    ).resolves.toEqual([])
  })

  it('discards entries when a collapsed directory changes during readdir', async () => {
    const root = await makeTempRoot()
    const outsideRoot = await makeTempRoot()
    await mkdirRel(root, 'dist')
    await writeRel(outsideRoot, 'secret.ts')
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises') // eslint-disable-line @typescript-eslint/consistent-type-imports -- vi.importActual requires inline import()
    const distPath = join(root, 'dist')
    let swapped = false
    readdirMock.mockImplementation(async (...args: Parameters<typeof actual.readdir>) => {
      if (!swapped && args[0] === distPath) {
        swapped = true
        await rename(distPath, join(root, 'old-dist'))
        await symlink(outsideRoot, distPath, 'dir')
      }
      return actual.readdir(...args)
    })

    try {
      await expect(
        expandQuickOpenGitFileListing({
          rootPath: root,
          gitPaths: [],
          directoryPaths: ['dist/']
        })
      ).resolves.toEqual([])
    } finally {
      readdirMock.mockImplementation(actual.readdir)
    }
  })

  it('walks overlapping primary and ignored placeholders only once', async () => {
    const root = await makeTempRoot()
    await writeRel(root, 'foo/a.ts')
    await writeRel(root, 'foo/bar/b.ts')

    await expect(
      expandQuickOpenGitFileListing({
        rootPath: root,
        gitPaths: [],
        directoryPaths: ['foo/', 'foo/bar/'],
        budget: createQuickOpenReaddirBudget({ maxFiles: 2 })
      })
    ).resolves.toEqual(['foo/a.ts', 'foo/bar/b.ts'])

    expect(
      readdirMock.mock.calls.filter(([path]) => path === join(root, 'foo', 'bar'))
    ).toHaveLength(1)
  })

  it('rejects instead of returning a partial ignored-directory expansion', async () => {
    const root = await makeTempRoot()
    await writeRel(root, 'dist/a.js')
    await writeRel(root, 'dist/b.js')

    await expect(
      expandQuickOpenGitFileListing({
        rootPath: root,
        gitPaths: [],
        directoryPaths: ['dist/'],
        budget: createQuickOpenReaddirBudget({ maxFiles: 1 })
      })
    ).rejects.toThrow('File listing exceeded')
  })

  it('keeps the default safety cap for a very large collapsed directory', async () => {
    const root = await makeTempRoot()
    await mkdirRel(root, 'dist')
    readdirMock.mockResolvedValueOnce(
      Array.from({ length: QUICK_OPEN_READDIR_MAX_FILES + 1 }, (_, index) => ({
        name: `file-${index}.ts`,
        isDirectory: () => false,
        isFile: () => true,
        isSymbolicLink: () => false
      }))
    )

    // Why: directory collapse prevents generated trees from flooding the relay;
    // the Git fallback must reject rather than silently return a partial list.
    await expect(
      expandQuickOpenGitFileListing({
        rootPath: root,
        gitPaths: [],
        directoryPaths: ['dist/']
      })
    ).rejects.toThrow('File listing exceeded 10000 files')
  })

  it('identifies budget errors so callers can translate only those to install-rg guidance', () => {
    expect(isQuickOpenReaddirBudgetError(new Error('File listing timed out'))).toBe(true)
    expect(isQuickOpenReaddirBudgetError(new Error('File listing exceeded 10000 files'))).toBe(true)
    // Genuine git failures must keep their own message, not the install-rg toast.
    expect(isQuickOpenReaddirBudgetError(new Error('git ls-files killed by SIGTERM'))).toBe(false)
    expect(isQuickOpenReaddirBudgetError('File listing timed out')).toBe(false)
  })

  it('rejects on deadline instead of returning a partial list', async () => {
    const root = await makeTempRoot()
    await writeRel(root, 'src/index.ts')

    await expect(
      listQuickOpenFilesWithReaddir(root, {
        budget: { remainingFiles: 10, deadlineMs: Date.now() - 1_000 }
      })
    ).rejects.toThrow('File listing timed out')
  })

  it('does not list symlinked files or follow symlinked directories', async () => {
    const root = await makeTempRoot()
    await writeRel(root, 'src/index.ts')
    await writeRel(root, 'target/file.ts')

    try {
      await symlink(join(root, 'src/index.ts'), join(root, 'src/link.ts'))
      await symlink(join(root, 'target'), join(root, 'linked-dir'), 'dir')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EPERM') {
        return
      }
      throw err
    }

    const files = await listQuickOpenFilesWithReaddir(root)
    expect(files).toEqual(expect.arrayContaining(['src/index.ts', 'target/file.ts']))
    expect(files).not.toContain('src/link.ts')
    expect(files).not.toContain('linked-dir/file.ts')
  })

  it('walks an explicitly selected symlinked workspace root', async () => {
    const targetRoot = await makeTempRoot()
    const linkContainer = await makeTempRoot()
    await writeRel(targetRoot, 'src/index.ts')
    const linkedRoot = join(linkContainer, 'linked-workspace')

    try {
      await symlink(targetRoot, linkedRoot, 'dir')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EPERM') {
        return
      }
      throw err
    }

    await expect(listQuickOpenFilesWithReaddir(linkedRoot)).resolves.toEqual(['src/index.ts'])
  })

  it('fills nested repo paths containing spaces and glob metacharacters', async () => {
    const root = await makeTempRoot()
    await makeNestedRepo(root, 'packages/app [one] space')
    await writeRel(root, 'packages/app [one] space/src/main.ts')

    await expect(
      expandQuickOpenGitFileListing({
        rootPath: root,
        gitPaths: ['packages/app [one] space/']
      })
    ).resolves.toEqual(['packages/app [one] space/src/main.ts'])
  })

  it('stops the walk with a cancellation error when the signal aborts (#7721)', async () => {
    const root = await makeTempRoot()
    await writeRel(root, 'src/a.ts')
    await writeRel(root, 'src/b.ts')

    const controller = new AbortController()
    controller.abort()

    const rejection = listQuickOpenFilesWithReaddir(root, { signal: controller.signal })
    await expect(rejection).rejects.toSatisfy(isFileListingCancellation)
    // Cancellation must never be mistaken for a budget error, which callers
    // translate into "install rg" guidance.
    await rejection.catch((err) => expect(isQuickOpenReaddirBudgetError(err)).toBe(false))
  })

  it('stops ignored-directory expansion when the signal aborts (#7721)', async () => {
    const root = await makeTempRoot()
    await writeRel(root, 'src/kept.ts')

    const controller = new AbortController()
    controller.abort()

    await expect(
      expandQuickOpenGitFileListing({
        rootPath: root,
        gitPaths: [],
        directoryPaths: ['src/'],
        signal: controller.signal
      })
    ).rejects.toSatisfy(isFileListingCancellation)
  })

  it('rejects when cancellation lands during an empty readdir batch', async () => {
    const root = await makeTempRoot()
    const controller = new AbortController()
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises') // eslint-disable-line @typescript-eslint/consistent-type-imports -- vi.importActual requires inline import()
    readdirMock.mockImplementationOnce(async (...args: Parameters<typeof actual.readdir>) => {
      const entries = await actual.readdir(...args)
      controller.abort()
      return entries
    })

    await expect(
      listQuickOpenFilesWithReaddir(root, { signal: controller.signal })
    ).rejects.toSatisfy(isFileListingCancellation)
  })
})
