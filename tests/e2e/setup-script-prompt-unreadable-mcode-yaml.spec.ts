import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/mcode-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { worktreeRow, worktreeRowSurface } from './worktree-row-locators'

const INSPECTION_ERROR_TEXT = "Couldn't verify this repo's setup script right now."
const SETUP_SCRIPT_COMMAND = 'echo mcode-e2e-setup'
const RECORDING_DWELL_MS = 1200

type WorktreeIds = {
  repoId: string
  mainWorktreeId: string
  featureWorktreeId: string
}

function runGit(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' })
}

/** Repo whose shared mcode.yaml carries a real setup script, plus a second worktree. */
function createRepoWithSharedSetupScript(repoPath: string, featureWorktreePath: string): void {
  rmSync(repoPath, { recursive: true, force: true })
  rmSync(featureWorktreePath, { recursive: true, force: true })
  mkdirSync(repoPath, { recursive: true })
  runGit(repoPath, ['init'])
  runGit(repoPath, ['config', 'user.email', 'e2e@test.local'])
  runGit(repoPath, ['config', 'user.name', 'E2E Test'])
  writeFileSync(path.join(repoPath, 'README.md'), '# Unreadable mcode.yaml E2E\n')
  writeFileSync(path.join(repoPath, 'mcode.yaml'), `scripts:\n  setup: ${SETUP_SCRIPT_COMMAND}\n`)
  runGit(repoPath, ['add', '-A'])
  runGit(repoPath, ['commit', '-m', 'Initial commit'])
  runGit(repoPath, ['worktree', 'add', '-b', 'setup-prompt-proof', featureWorktreePath])
}

/**
 * Makes the main process report the failure the fix now surfaces: mcode.yaml could
 * not be read (SSH filesystem provider gone), so the hook check fails closed with
 * `status: 'error'` instead of an authoritative "no setup script".
 * The real handler stays captured so healing restores production behavior.
 */
async function installUnreadableMCodeYamlFault(electronApp: ElectronApplication): Promise<void> {
  await electronApp.evaluate(({ ipcMain }) => {
    type InvokeHandler = (event: unknown, ...args: unknown[]) => unknown
    const faultState = globalThis as typeof globalThis & { __mcodeE2eMCodeYamlUnreadable?: boolean }
    const registry = (ipcMain as unknown as { _invokeHandlers?: Map<string, InvokeHandler> })
      ._invokeHandlers
    const productionHandler = registry?.get('hooks:check')
    if (!productionHandler) {
      throw new Error('hooks:check handler was not registered in the main process')
    }
    faultState.__mcodeE2eMCodeYamlUnreadable = true
    ipcMain.removeHandler('hooks:check')
    ipcMain.handle('hooks:check', async (event, ...args) => {
      if (faultState.__mcodeE2eMCodeYamlUnreadable) {
        return { status: 'error', hasHooks: false, hooks: null, mayNeedUpdate: false }
      }
      return productionHandler(event, ...args)
    })
  })
}

/** mcode.yaml becomes readable again — every later check runs the production handler. */
async function healMCodeYamlRead(electronApp: ElectronApplication): Promise<void> {
  await electronApp.evaluate(() => {
    ;(
      globalThis as typeof globalThis & { __mcodeE2eMCodeYamlUnreadable?: boolean }
    ).__mcodeE2eMCodeYamlUnreadable = false
  })
}

async function addRepoAndActivateMainWorktree(
  page: Page,
  repoPath: string,
  featureWorktreePath: string
): Promise<WorktreeIds> {
  // Why: repos hide externally created worktrees by default, so the second
  // worktree only reaches the sidebar once the repo opts into showing them.
  const repoId = await page.evaluate(async (targetRepoPath) => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is not available')
    }
    const addedRepo = await store.getState().addRepoPath(targetRepoPath)
    if (!addedRepo) {
      throw new Error(`Failed to add repo at ${targetRepoPath}`)
    }
    await store.getState().updateRepo(addedRepo.id, { externalWorktreeVisibility: 'show' })
    return addedRepo.id
  }, repoPath)

  await expect
    .poll(
      () =>
        page.evaluate(async (targetRepoId) => {
          const store = window.__store
          if (!store) {
            return 0
          }
          await store.getState().fetchWorktrees(targetRepoId)
          return store.getState().worktreesByRepo[targetRepoId]?.length ?? 0
        }, repoId),
      { timeout: 20_000, message: 'proof repo worktrees did not load' }
    )
    .toBeGreaterThanOrEqual(2)

  return page.evaluate(
    ({ targetRepoId, targetRepoPath, targetFeaturePath }) => {
      const store = window.__store
      if (!store) {
        throw new Error('window.__store is not available')
      }
      const normalize = (value: string): string =>
        value.startsWith('/private/var/') ? value.slice('/private'.length) : value

      const state = store.getState()
      const worktrees = state.worktreesByRepo[targetRepoId] ?? []
      const mainWorktree = worktrees.find(
        (entry) => normalize(entry.path) === normalize(targetRepoPath)
      )
      const featureWorktree = worktrees.find(
        (entry) => normalize(entry.path) === normalize(targetFeaturePath)
      )
      if (!mainWorktree || !featureWorktree) {
        throw new Error(
          `Missing worktrees for ${targetRepoPath}: ${worktrees.map((entry) => entry.path).join(', ')}`
        )
      }

      state.setSidebarOpen(true)
      state.setGroupBy('none')
      state.setSortBy('recent')
      state.setShowActiveOnly(false)
      state.setShowSleepingWorkspaces(true)
      state.setHideDefaultBranchWorkspace(false)
      state.setFilterRepoIds([])
      state.setActiveRepo(targetRepoId)
      state.setActiveWorktree(mainWorktree.id)
      state.revealWorktreeInSidebar(featureWorktree.id, { behavior: 'auto' })
      return {
        repoId: targetRepoId,
        mainWorktreeId: mainWorktree.id,
        featureWorktreeId: featureWorktree.id
      }
    },
    { targetRepoId: repoId, targetRepoPath: repoPath, targetFeaturePath: featureWorktreePath }
  )
}

test.describe('Setup script prompt', () => {
  test.beforeEach(async ({ mcodePage }) => {
    await waitForSessionReady(mcodePage)
    await waitForActiveWorktree(mcodePage)
  })

  test('recovers from an unreadable mcode.yaml instead of pinning the failed verdict', async ({
    electronApp,
    mcodePage
  }, testInfo) => {
    const repoPath = testInfo.outputPath('unreadable-mcode-yaml-repo')
    const featureWorktreePath = testInfo.outputPath('unreadable-mcode-yaml-feature')
    createRepoWithSharedSetupScript(repoPath, featureWorktreePath)

    await installUnreadableMCodeYamlFault(electronApp)
    const { repoId, featureWorktreeId } = await addRepoAndActivateMainWorktree(
      mcodePage,
      repoPath,
      featureWorktreePath
    )

    const promptCard = mcodePage.locator('[data-setup-script-prompt-layer]')
    const inspectionError = promptCard.getByText(INSPECTION_ERROR_TEXT)
    await expect(inspectionError).toBeVisible({ timeout: 20_000 })

    // mcode.yaml is readable again; the card is still pinned to the failed verdict.
    await healMCodeYamlRead(electronApp)
    const healthyCheck = await mcodePage.evaluate(
      (targetRepoId) => window.api.hooks.check({ repoId: targetRepoId }),
      repoId
    )
    expect(healthyCheck.status).toBe('ok')
    expect((healthyCheck.hooks as { scripts?: { setup?: string } } | null)?.scripts?.setup).toBe(
      SETUP_SCRIPT_COMMAND
    )
    await expect(inspectionError).toBeVisible()
    await expect(promptCard.getByRole('button', { name: 'Retry' })).toBeVisible()
    // Not a wait for state: holds the pinned card on screen for the proof recording.
    await mcodePage.waitForTimeout(RECORDING_DWELL_MS)

    // Activating another worktree in the same repo must re-inspect.
    const featureRow = worktreeRow(mcodePage, featureWorktreeId)
    await expect(featureRow).toBeVisible()
    await worktreeRowSurface(mcodePage, featureWorktreeId).click()
    await expect(featureRow).toHaveAttribute('aria-current', 'page')

    // The repo has a valid mcode.yaml scripts.setup, so no prompt may remain.
    await expect(inspectionError).toBeHidden({ timeout: 20_000 })
    await expect(promptCard).toHaveCount(0)
    await mcodePage.waitForTimeout(RECORDING_DWELL_MS)
  })
})
