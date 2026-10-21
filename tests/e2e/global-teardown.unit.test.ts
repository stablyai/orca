import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  cleanupTestRepository,
  cleanupTestRepositoryPathFiles,
  linkedWorktreePaths
} from './global-teardown'

const roots: string[] = []

function git(cwd: string, args: string[]): void {
  execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe' })
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('E2E global teardown ownership', () => {
  it('cleans orphaned worker publications while preserving another run', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-worker-teardown-'))
    roots.push(root)
    const runPathFile = path.join(root, 'run.txt')
    const ownedRepositories = ['seed', 'worker-0', 'worker-3'].map((name) => {
      const repository = path.join(root, name)
      mkdirSync(repository)
      git(repository, ['init'])
      return repository
    })
    const publications = [runPathFile, `${runPathFile}.worker-0`, `${runPathFile}.worker-3`]
    publications.forEach((publication, index) => {
      writeFileSync(publication, ownedRepositories[index]!)
    })
    const unrelatedRepo = path.join(root, 'unrelated')
    mkdirSync(unrelatedRepo)
    const unrelatedPublication = path.join(root, 'another-run.txt.worker-0')
    writeFileSync(unrelatedPublication, unrelatedRepo)

    cleanupTestRepositoryPathFiles(runPathFile)

    expect(ownedRepositories.every((repository) => !existsSync(repository))).toBe(true)
    expect(publications.every((publication) => !existsSync(publication))).toBe(true)
    expect(existsSync(unrelatedRepo)).toBe(true)
    expect(existsSync(unrelatedPublication)).toBe(true)
  })

  it('removes every linked run worktree and preserves unrelated siblings', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-teardown-contract-'))
    roots.push(root)
    const repoPath = path.join(root, 'orca-e2e-repo-run')
    const firstWorktreePath = path.join(root, 'orca-e2e-worktree-owned')
    const secondWorktreePath = path.join(root, 'e2e-test-owned')
    const concurrentWorktreePath = path.join(root, 'orca-e2e-worktree-concurrent')
    const unrelatedTestPath = path.join(root, 'e2e-test-unrelated')
    mkdirSync(repoPath)
    mkdirSync(concurrentWorktreePath)
    mkdirSync(unrelatedTestPath)
    writeFileSync(path.join(repoPath, 'README.md'), 'fixture\n')
    git(repoPath, ['init'])
    git(repoPath, ['config', 'user.email', 'e2e@test.local'])
    git(repoPath, ['config', 'user.name', 'E2E Test'])
    git(repoPath, ['add', 'README.md'])
    git(repoPath, ['commit', '-m', 'seed'])
    git(repoPath, ['worktree', 'add', '-b', 'first-owned', firstWorktreePath])
    git(repoPath, ['worktree', 'add', '-b', 'second-owned', secondWorktreePath])

    expect(new Set(linkedWorktreePaths(repoPath))).toEqual(
      new Set([realpathSync.native(firstWorktreePath), realpathSync.native(secondWorktreePath)])
    )
    cleanupTestRepository(repoPath)

    expect(existsSync(repoPath)).toBe(false)
    expect(existsSync(firstWorktreePath)).toBe(false)
    expect(existsSync(secondWorktreePath)).toBe(false)
    expect(existsSync(concurrentWorktreePath)).toBe(true)
    expect(existsSync(unrelatedTestPath)).toBe(true)
  })
})
