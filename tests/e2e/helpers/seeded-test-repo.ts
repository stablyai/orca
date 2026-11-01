import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { seedTestRepository, TEST_REPO_PATH_FILE } from '../global-setup'
import { cleanupTestRepository } from '../global-teardown'

export async function provideWorkerTestRepository(
  provideFixture: (repository: string) => Promise<void>
): Promise<void> {
  const persistedRepoPath = existsSync(TEST_REPO_PATH_FILE)
    ? readFileSync(TEST_REPO_PATH_FILE, 'utf-8').trim()
    : ''
  const repoPath = isValidGitRepo(persistedRepoPath) ? persistedRepoPath : createSeededTestRepo()
  try {
    await provideFixture(repoPath)
  } finally {
    if (existsSync(repoPath)) {
      cleanupTestRepository(repoPath)
    }
    rmSync(TEST_REPO_PATH_FILE, { force: true })
  }
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

export function createSeededTestRepo(options: { publishPath?: boolean } = {}): string {
  const testRepoDir = seedTestRepository()
  if (options.publishPath !== false) {
    writeFileSync(TEST_REPO_PATH_FILE, testRepoDir)
  }
  return testRepoDir
}
