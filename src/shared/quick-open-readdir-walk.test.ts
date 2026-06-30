import { afterEach, describe, expect, it, vi } from 'vitest'

const { lstatMock } = vi.hoisted(() => ({
  lstatMock: vi.fn()
}))

vi.mock('fs/promises', async () => {
  const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises') // eslint-disable-line @typescript-eslint/consistent-type-imports -- vi.importActual requires inline import()
  lstatMock.mockImplementation(actual.lstat)
  return {
    ...actual,
    lstat: lstatMock
  }
})

import { mkdtemp, mkdir, rm, symlink, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import {
  classifyQuickOpenGitEntry,
  createQuickOpenReaddirBudget,
  expandQuickOpenGitFilesWithNestedRepos,
  isQuickOpenReaddirBudgetError,
  listQuickOpenFilesWithReaddir,
  parseQuickOpenGitLsFilesEntry
} from './quick-open-readdir-walk'

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
      expandQuickOpenGitFilesWithNestedRepos({
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
      expandQuickOpenGitFilesWithNestedRepos({
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
      expandQuickOpenGitFilesWithNestedRepos({
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
      expandQuickOpenGitFilesWithNestedRepos({
        rootPath: root,
        gitPaths: [staged('160000', 'packages/app')],
        excludePathPrefixes: ['packages/app/excluded'],
        budget: createQuickOpenReaddirBudget({ maxFiles: 5 })
      })
    ).resolves.toEqual(['packages/app/keep.ts'])
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

  it('fills nested repo paths containing spaces and glob metacharacters', async () => {
    const root = await makeTempRoot()
    await makeNestedRepo(root, 'packages/app [one] space')
    await writeRel(root, 'packages/app [one] space/src/main.ts')

    await expect(
      expandQuickOpenGitFilesWithNestedRepos({
        rootPath: root,
        gitPaths: ['packages/app [one] space/']
      })
    ).resolves.toEqual(['packages/app [one] space/src/main.ts'])
  })
})
