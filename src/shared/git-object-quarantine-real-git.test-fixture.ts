import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { GIT_OBJECT_QUARANTINE_DIR_PREFIX } from './git-object-quarantine'

/**
 * A repository where `merge-tree --write-tree` has real work to do:
 * - `feature-conflict` conflicts with `main` on `shared.txt` (checked out in a linked worktree);
 * - `feature-extra` adds a file `main` lacks, so merging it produces a brand-new tree;
 * - `feature-squashed` adds a file `main` later received through a separate (squash) commit.
 */
export type DivergentRepoFixture = {
  repoPath: string
  linkedPath: string
  commonDir: string
  git: (cwd: string, ...args: string[]) => string
  /** Files under the real object store's `objects/xx` fan-out directories. */
  looseObjectCount: () => number
  scratchDirectories: () => string[]
  addWorktree: (name: string, branch: string) => string
  /** A blob-less clone of the repo, so merge-tree must fetch file contents on demand. */
  createPartialClone: () => PartialCloneFixture
  dispose: () => void
}

export type PartialCloneFixture = {
  clonePath: string
  looseObjectCount: () => number
  /** Packs in the clone's real `objects/pack`, each named by its `.idx`. */
  packCount: () => number
  scratchDirectories: () => string[]
}

function looseObjectCountIn(objectsDir: string): number {
  return readdirSync(objectsDir)
    .filter((entry) => /^[0-9a-f]{2}$/.test(entry))
    .reduce((count, entry) => count + readdirSync(join(objectsDir, entry)).length, 0)
}

function scratchDirectoriesIn(objectsDir: string): string[] {
  return readdirSync(objectsDir).filter((entry) =>
    entry.startsWith(GIT_OBJECT_QUARANTINE_DIR_PREFIX)
  )
}

export function createDivergentRepoFixture(): DivergentRepoFixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'orca-merge-tree-quarantine-')))
  const repoPath = join(root, 'repo')
  const git = (cwd: string, ...args: string[]): string =>
    execFileSync('git', args, { cwd, encoding: 'utf8' })
  const write = (name: string, content: string): void => {
    writeFileSync(join(repoPath, name), content)
  }
  const commit = (message: string): void => {
    git(repoPath, 'add', '-A')
    git(repoPath, 'commit', '--quiet', '-m', message)
  }

  execFileSync('git', ['init', '--quiet', repoPath])
  git(repoPath, 'config', 'user.name', 'Orca Test')
  git(repoPath, 'config', 'user.email', 'orca@example.test')
  git(repoPath, 'config', 'commit.gpgSign', 'false')
  git(repoPath, 'config', 'core.hooksPath', '.git/no-hooks')
  git(repoPath, 'config', 'gc.auto', '0')
  git(repoPath, 'checkout', '--quiet', '-b', 'main')
  write('shared.txt', 'base\n')
  commit('base')

  git(repoPath, 'checkout', '--quiet', '-b', 'feature-conflict')
  write('shared.txt', 'feature\n')
  write('conflict-only.txt', 'feature only\n')
  commit('feature conflict')

  git(repoPath, 'checkout', '--quiet', '-b', 'feature-extra', 'main')
  write('extra.txt', 'extra\n')
  commit('feature extra')

  git(repoPath, 'checkout', '--quiet', '-b', 'feature-squashed', 'main')
  write('squashed.txt', 'squashed\n')
  commit('feature squashed')

  git(repoPath, 'checkout', '--quiet', 'main')
  write('shared.txt', 'main\n')
  write('main-only.txt', 'main only\n')
  commit('main moves on')
  write('squashed.txt', 'squashed\n')
  commit('squash merge of feature-squashed')

  const linkedPath = join(root, 'linked')
  git(repoPath, 'worktree', 'add', '--quiet', linkedPath, 'feature-conflict')
  // Why: start from a packed store so every loose object is one the code under test wrote.
  git(repoPath, 'gc', '--quiet', '--prune=now')

  const commonDir = join(repoPath, '.git')
  const objectsDir = join(commonDir, 'objects')
  return {
    repoPath,
    linkedPath,
    commonDir,
    git,
    looseObjectCount: () => looseObjectCountIn(objectsDir),
    scratchDirectories: () => scratchDirectoriesIn(objectsDir),
    addWorktree: (name, branch) => {
      const worktreePath = join(root, name)
      git(repoPath, 'worktree', 'add', '--quiet', worktreePath, branch)
      return worktreePath
    },
    createPartialClone: () => {
      git(repoPath, 'config', 'uploadpack.allowFilter', 'true')
      const clonePath = join(root, 'partial')
      git(
        root,
        'clone',
        '--quiet',
        '--no-checkout',
        '--filter=blob:none',
        pathToFileURL(repoPath).href,
        clonePath
      )
      const cloneObjectsDir = join(clonePath, '.git', 'objects')
      return {
        clonePath,
        looseObjectCount: () => looseObjectCountIn(cloneObjectsDir),
        packCount: () =>
          readdirSync(join(cloneObjectsDir, 'pack')).filter((entry) => entry.endsWith('.idx'))
            .length,
        scratchDirectories: () => scratchDirectoriesIn(cloneObjectsDir)
      }
    },
    dispose: () => rmSync(root, { recursive: true, force: true })
  }
}
