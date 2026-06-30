import { execSync } from 'child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import os from 'os'
import path from 'path'
import { TEST_REPO_PATH_FILE } from '../global-setup'

export type SeededRepo = {
  repoPath: string
  worktreePath: string
}

export function isValidGitRepo(repoPath: string): boolean {
  if (!repoPath || !existsSync(repoPath)) {
    return false
  }

  try {
    return (
      execSync('git rev-parse --is-inside-work-tree', {
        cwd: repoPath,
        stdio: 'pipe',
        encoding: 'utf8'
      }).trim() === 'true'
    )
  } catch {
    return false
  }
}

export function createSeededTestRepo(options?: {
  persistPathFile?: boolean
  repoPrefix?: string
  worktreePrefix?: string
}): SeededRepo {
  const uniqueId = `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2)}`
  const testRepoDir = path.join(
    os.tmpdir(),
    `${options?.repoPrefix ?? 'orca-e2e-repo'}-${uniqueId}`
  )
  mkdirSync(testRepoDir, { recursive: true })

  execSync('git init', { cwd: testRepoDir, stdio: 'pipe' })
  execSync('git config user.email "e2e@test.local"', { cwd: testRepoDir, stdio: 'pipe' })
  execSync('git config user.name "E2E Test"', { cwd: testRepoDir, stdio: 'pipe' })

  writeFileSync(
    path.join(testRepoDir, 'README.md'),
    '# Orca E2E Test Repo\n\nThis repo was created automatically for Playwright tests.\n'
  )
  writeFileSync(path.join(testRepoDir, 'CLAUDE.md'), '# CLAUDE.md\n\nTest instructions for E2E.\n')
  writeFileSync(
    path.join(testRepoDir, 'package.json'),
    `${JSON.stringify({ name: 'orca-e2e-test', version: '0.0.0', private: true }, null, 2)}\n`
  )
  writeFileSync(path.join(testRepoDir, '.gitignore'), 'node_modules/\n')
  mkdirSync(path.join(testRepoDir, 'src'), { recursive: true })
  writeFileSync(path.join(testRepoDir, 'src', 'index.ts'), 'export const hello = "world"\n')

  execSync('git add -A', { cwd: testRepoDir, stdio: 'pipe' })
  execSync('git commit -m "Initial commit for E2E tests"', { cwd: testRepoDir, stdio: 'pipe' })

  const worktreeDir = path.join(
    testRepoDir,
    '..',
    `${options?.worktreePrefix ?? 'orca-e2e-worktree'}-${uniqueId}`
  )
  execSync(`git worktree add "${worktreeDir}" -b e2e-secondary`, {
    cwd: testRepoDir,
    stdio: 'pipe'
  })

  if (options?.persistPathFile !== false) {
    writeFileSync(TEST_REPO_PATH_FILE, testRepoDir)
  }
  return { repoPath: testRepoDir, worktreePath: worktreeDir }
}

export function removeTree(pathToRemove: string): void {
  rmSync(pathToRemove, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
