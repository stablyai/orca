import { execFileSync } from 'node:child_process'
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { expect } from './helpers/orca-app'

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
  catalogFolderPath: string
  cloneParentPath: string
  clonedRepoPath: string
  createdRepoPath: string
  createParentPath: string
  folderPath: string
  gitPath: string
  localCloneCollisionPath: string
  localCreateCollisionPath: string
  nestedParentPath: string
  nestedRepoPaths: string[]
  reconnectCatalogPath: string
  rootPath: string
}> {
  const rootPath = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'orca-pr11346-headed-')))
  const gitPath = path.join(rootPath, 'remote-git-project')
  const folderPath = path.join(rootPath, 'remote-plain-folder')
  const cloneParentPath = path.join(rootPath, 'remote-clones')
  const createParentPath = path.join(rootPath, 'remote-created-projects')
  const nestedParentPath = path.join(rootPath, 'remote-nested-projects')
  const catalogFolderPath = path.join(nestedParentPath, 'catalog-workspace')
  const reconnectCatalogPath = path.join(rootPath, 'reconnect-catalog')
  const localCloneCollisionPath = path.join(rootPath, 'local-clone-collision')
  const localCreateCollisionPath = path.join(rootPath, 'local-create-collision')
  const nestedRepoPaths = ['nested-api', 'nested-web'].map((name) =>
    path.join(nestedParentPath, name)
  )
  mkdirSync(folderPath)
  mkdirSync(cloneParentPath)
  mkdirSync(createParentPath)
  writeFileSync(path.join(folderPath, 'REMOTE_FOLDER_MARKER.txt'), 'remote-folder-authority\n')
  initializeGitRepo(gitPath, 'REMOTE_GIT_MARKER.md')
  initializeGitRepo(localCloneCollisionPath, 'LOCAL_CLONE_COLLISION.md')
  initializeGitRepo(localCreateCollisionPath, 'LOCAL_CREATE_COLLISION.md')
  nestedRepoPaths.forEach((repoPath) => initializeGitRepo(repoPath, 'NESTED_REMOTE_MARKER.md'))
  mkdirSync(catalogFolderPath)
  mkdirSync(reconnectCatalogPath)
  return {
    catalogFolderPath,
    cloneParentPath,
    clonedRepoPath: path.join(cloneParentPath, path.basename(gitPath)),
    createParentPath,
    createdRepoPath: path.join(createParentPath, 'runtime-created-project'),
    folderPath,
    gitPath,
    localCloneCollisionPath,
    localCreateCollisionPath,
    nestedParentPath,
    nestedRepoPaths,
    reconnectCatalogPath,
    rootPath
  }
}

export async function expectRuntimeActivation(
  page: Page,
  targetPath: string,
  environmentId: string
): Promise<string> {
  const hostId = `runtime:${environmentId}` as const
  await expect
    .poll(
      () =>
        page.evaluate((hostId) => {
          const state = window.__store?.getState()
          const active = state?.activeWorktreeId
            ? state.getKnownWorktreeById(state.activeWorktreeId, hostId)
            : null
          return {
            activeHostId: state?.activeWorkspaceExecutionHostId ?? null,
            activePath: active?.path ?? null
          }
        }, hostId),
      { timeout: 60_000 }
    )
    .toEqual({ activeHostId: hostId, activePath: targetPath })
  return page.evaluate(
    ({ hostId, targetPath }) => {
      const state = window.__store?.getState()
      if (!state?.activeWorktreeId || state.activeWorkspaceExecutionHostId !== hostId) {
        throw new Error('Selected runtime workspace is not active')
      }
      const active = state.getKnownWorktreeById(state.activeWorktreeId, hostId)
      if (active?.path !== targetPath) {
        throw new Error('Selected runtime project is not active')
      }
      return state.activeWorktreeId
    },
    { hostId, targetPath }
  )
}
