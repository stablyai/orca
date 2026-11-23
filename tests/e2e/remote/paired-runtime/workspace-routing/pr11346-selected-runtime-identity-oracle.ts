import { execFileSync } from 'node:child_process'
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export function configureIsolatedGitIdentity(homePath: string): void {
  writeFileSync(
    path.join(homePath, '.gitconfig'),
    '[user]\n\tname = PR 11346 E2E\n\temail = pr11346@test.local\n'
  )
}

function initializeGitRepo(repoPath: string, markerName: string): void {
  mkdirSync(repoPath, { recursive: true })
  execFileSync('git', ['init'], { cwd: repoPath, stdio: 'pipe' })
  execFileSync('git', ['config', 'user.email', 'pr11346@test.local'], {
    cwd: repoPath,
    stdio: 'pipe'
  })
  execFileSync('git', ['config', 'user.name', 'PR 11346 E2E'], {
    cwd: repoPath,
    stdio: 'pipe'
  })
  writeFileSync(path.join(repoPath, markerName), `# ${path.basename(repoPath)} authority\n`)
  execFileSync('git', ['add', markerName], { cwd: repoPath, stdio: 'pipe' })
  execFileSync('git', ['commit', '-m', 'Initial remote fixture'], {
    cwd: repoPath,
    stdio: 'pipe'
  })
}

export async function createProjectFixtures(): Promise<{
  cloneParentPath: string
  clonedRepoPath: string
  createdRepoPath: string
  createParentPath: string
  folderPath: string
  gitPath: string
  nestedParentPath: string
  nestedRepoPaths: string[]
  rootPath: string
}> {
  const rootPath = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'orca-pr11346-headed-')))
  const gitPath = path.join(rootPath, 'remote-git-project')
  const folderPath = path.join(rootPath, 'remote-plain-folder')
  const cloneParentPath = path.join(rootPath, 'remote-clones')
  const createParentPath = path.join(rootPath, 'remote-created-projects')
  const nestedParentPath = path.join(rootPath, 'remote-nested-projects')
  const nestedRepoPaths = ['nested-api', 'nested-web'].map((name) =>
    path.join(nestedParentPath, name)
  )
  mkdirSync(folderPath)
  mkdirSync(cloneParentPath)
  mkdirSync(createParentPath)
  writeFileSync(path.join(folderPath, 'REMOTE_FOLDER_MARKER.txt'), 'remote-folder-authority\n')
  initializeGitRepo(gitPath, 'REMOTE_GIT_MARKER.md')
  nestedRepoPaths.forEach((repoPath) => initializeGitRepo(repoPath, 'NESTED_REMOTE_MARKER.md'))
  return {
    cloneParentPath,
    clonedRepoPath: path.join(cloneParentPath, path.basename(gitPath)),
    createParentPath,
    createdRepoPath: path.join(createParentPath, 'runtime-created-project'),
    folderPath,
    gitPath,
    nestedParentPath,
    nestedRepoPaths,
    rootPath
  }
}
