import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanupTestRepository, linkedWorktreePaths } from './global-teardown'

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
      new Set([realpathSync(firstWorktreePath), realpathSync(secondWorktreePath)])
    )
    cleanupTestRepository(repoPath)

    expect(existsSync(repoPath)).toBe(false)
    expect(existsSync(firstWorktreePath)).toBe(false)
    expect(existsSync(secondWorktreePath)).toBe(false)
    expect(existsSync(concurrentWorktreePath)).toBe(true)
    expect(existsSync(unrelatedTestPath)).toBe(true)
  })
})
