import { execFileSync } from 'node:child_process'
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import type { AppState } from '../../src/renderer/src/store/types'
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

type ActivationCollision = {
  localWorktreeId: string
  runtimeWorktreeId: string
}

export async function installFinalActivationGate(page: Page, targetPath: string): Promise<void> {
  await page.evaluate((pathToGate) => {
    const store = window.__store
    if (!store) {
      throw new Error('Renderer store unavailable')
    }
    const originalFetchWorktrees = store.getState().fetchWorktrees
    let release!: () => void
    const released = new Promise<void>((resolve) => {
      release = resolve
    })
    const gateWindow = window as typeof window & {
      __pr11346ActivationGate?: {
        originalFetchWorktrees: typeof originalFetchWorktrees
        release: () => void
        waiting: boolean
      }
    }
    gateWindow.__pr11346ActivationGate = {
      originalFetchWorktrees,
      release,
      waiting: false
    }
    store.setState({
      fetchWorktrees: async (...args: Parameters<typeof originalFetchWorktrees>) => {
        const result = await originalFetchWorktrees(...args)
        const targetRepo = store
          .getState()
          .repos.find(
            (repo) =>
              repo.path === pathToGate && repo.executionHostId?.startsWith('runtime:') === true
          )
        if (targetRepo?.id === args[0]) {
          gateWindow.__pr11346ActivationGate!.waiting = true
          await released
        }
        return result
      }
    })
  }, targetPath)
}

export async function injectSameIdLocalActivationCollision(
  page: Page,
  targetPath: string,
  localPath: string
): Promise<ActivationCollision> {
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            (
              window as typeof window & {
                __pr11346ActivationGate?: { waiting: boolean }
              }
            ).__pr11346ActivationGate?.waiting ?? false
        ),
      { timeout: 60_000 }
    )
    .toBe(true)

  return page.evaluate(
    ({ localCollisionPath, runtimePath }) => {
      const store = window.__store
      const gateWindow = window as typeof window & {
        __pr11346ActivationGate?: {
          originalFetchWorktrees: AppState['fetchWorktrees']
          release: () => void
        }
      }
      const gate = gateWindow.__pr11346ActivationGate
      if (!store || !gate) {
        throw new Error('Activation gate unavailable')
      }
      const state = store.getState()
      const runtimeRepo = state.repos.find(
        (repo) => repo.path === runtimePath && repo.executionHostId?.startsWith('runtime:') === true
      )
      if (!runtimeRepo) {
        throw new Error(`Runtime repo unavailable for ${runtimePath}`)
      }
      const runtimeWorktree = state.worktreesByRepo[runtimeRepo.id]?.find(
        (worktree) =>
          worktree.hostId === runtimeRepo.executionHostId &&
          (worktree.isMainWorktree || worktree.path === runtimePath)
      )
      if (!runtimeWorktree) {
        throw new Error(`Runtime default checkout unavailable for ${runtimePath}`)
      }
      const localRepoId = `${runtimeRepo.id}-local-collision`
      const localWorktree = {
        ...runtimeWorktree,
        repoId: localRepoId,
        path: localCollisionPath,
        hostId: 'local' as const,
        runtimeOwnerEnvironmentId: null
      }
      store.setState({
        repos: [
          {
            ...runtimeRepo,
            id: localRepoId,
            path: localCollisionPath,
            displayName: `Local collision for ${runtimeRepo.displayName}`,
            executionHostId: 'local',
            connectionId: null
          },
          ...state.repos
        ],
        worktreesByRepo: {
          ...state.worktreesByRepo,
          [localRepoId]: [localWorktree]
        },
        fetchWorktrees: gate.originalFetchWorktrees
      })
      gate.release()
      delete gateWindow.__pr11346ActivationGate
      return {
        localWorktreeId: localWorktree.id,
        runtimeWorktreeId: runtimeWorktree.id
      }
    },
    { localCollisionPath: localPath, runtimePath: targetPath }
  )
}

export async function expectRuntimeActivation(
  page: Page,
  collision: ActivationCollision
): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const state = window.__store?.getState()
          return {
            activeWorktreeId: state?.activeWorktreeId ?? null,
            activeWorktreeHost: state?.activeWorkspaceExecutionHostId ?? null,
            sameIdHosts: Object.values(state?.worktreesByRepo ?? {})
              .flat()
              .filter((worktree) => worktree.id === state?.activeWorktreeId)
              .map((worktree) => worktree.hostId ?? 'local')
              .sort()
          }
        }),
      { timeout: 60_000 }
    )
    .toEqual({
      activeWorktreeHost: expect.stringMatching(/^runtime:/),
      activeWorktreeId: collision.runtimeWorktreeId,
      sameIdHosts: ['local', expect.stringMatching(/^runtime:/)]
    })
  expect(collision.runtimeWorktreeId).toBe(collision.localWorktreeId)
}
