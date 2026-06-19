import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Locator, Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

function runGit(repoPath: string, args: string[]): void {
  execFileSync('git', args, { cwd: repoPath, stdio: 'pipe' })
}

function createGitRepo(repoPath: string): void {
  rmSync(repoPath, { recursive: true, force: true })
  mkdirSync(repoPath, { recursive: true })
  runGit(repoPath, ['init'])
  runGit(repoPath, ['config', 'user.email', 'e2e@test.local'])
  runGit(repoPath, ['config', 'user.name', 'E2E Test'])
  writeFileSync(path.join(repoPath, 'README.md'), '# Setup import E2E\n')
  runGit(repoPath, ['add', '-A'])
  runGit(repoPath, ['commit', '-m', 'Initial commit'])
}

function createSupersetSetupRepo(repoPath: string): string {
  createGitRepo(repoPath)
  mkdirSync(path.join(repoPath, '.superset'), { recursive: true })
  writeFileSync(
    path.join(repoPath, '.superset', 'config.json'),
    `${JSON.stringify(
      {
        setup: ['bun install'],
        teardown: ['docker compose down'],
        cwd: 'packages/web'
      },
      null,
      2
    )}\n`
  )
  writeFileSync(
    path.join(repoPath, '.superset', 'config.local.json'),
    `${JSON.stringify(
      {
        setup: {
          before: ['corepack enable'],
          after: ['bun run db:migrate']
        },
        teardown: ['docker compose down --remove-orphans'],
        run: ['bun dev']
      },
      null,
      2
    )}\n`
  )
  return repoPath
}

function createCmuxSetupRepo(repoPath: string): string {
  createGitRepo(repoPath)
  mkdirSync(path.join(repoPath, '.cmux'), { recursive: true })
  writeFileSync(
    path.join(repoPath, '.cmux', 'cmux.json'),
    `${JSON.stringify(
      {
        commands: [
          {
            name: 'Run Unit Tests',
            keywords: ['test', 'unit'],
            command: './scripts/test-unit.sh'
          },
          {
            name: 'Setup',
            description: 'Initialize submodules and build dependencies',
            keywords: ['setup', 'init', 'install'],
            command: './scripts/setup.sh',
            confirm: true,
            cwd: 'packages/web'
          }
        ]
      },
      null,
      2
    )}\n`
  )
  return repoPath
}

async function addAndActivateRepo(page: Page, repoPath: string): Promise<string> {
  return page.evaluate(async (targetRepoPath) => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is not available')
    }

    const addedRepo = await store.getState().addRepoPath(targetRepoPath)
    if (!addedRepo) {
      throw new Error(`Failed to add repo at ${targetRepoPath}`)
    }

    await store.getState().fetchWorktrees(addedRepo.id)
    const state = store.getState()
    const worktree = state.worktreesByRepo[addedRepo.id]?.find(
      (entry) => entry.path === targetRepoPath
    )
    if (!worktree) {
      throw new Error(`Failed to find primary worktree for ${targetRepoPath}`)
    }

    state.setActiveRepo(addedRepo.id)
    state.setActiveWorktree(worktree.id)
    state.setSidebarOpen(true)
    return addedRepo.id
  }, repoPath)
}

async function openRepoSettings(page: Page, repoId: string): Promise<Locator> {
  await page.evaluate((targetRepoId) => {
    const state = window.__store?.getState()
    state?.setSettingsSearchQuery('')
    state?.openSettingsTarget({ pane: 'repo', repoId: targetRepoId })
    state?.openSettingsPage()
  }, repoId)

  const repoSettings = page.locator(`[data-settings-section="repo-${repoId}"]`)
  await expect(repoSettings).toBeVisible({ timeout: 10_000 })
  await expect(repoSettings.getByText('Setup Script').first()).toBeVisible()
  return repoSettings
}

async function openImportedSetupSettingsFromToast(page: Page, repoId: string): Promise<Locator> {
  const viewInSettings = page.getByRole('button', { name: "project's settings", exact: true })
  await expect(viewInSettings).toBeAttached({ timeout: 10_000 })
  // Why: in hidden Electron CI windows, the Sonner action can be laid out just
  // outside Playwright's viewport even though the action is mounted and wired.
  await viewInSettings.evaluate((button) => (button as HTMLButtonElement).click())
  const setupCommand = page.locator(`[id="repo-${repoId}-local-commands"]`)
  await expect(setupCommand).toBeVisible({ timeout: 10_000 })
  const repoSettings = page.locator(`[data-settings-section="repo-${repoId}"]`)
  await expect(repoSettings.getByText('Setup Script').first()).toBeVisible()
  return repoSettings
}

async function expectSettingsCommandValue(
  container: Locator,
  name: 'Setup Script' | 'Archive Script',
  value: string
): Promise<void> {
  await expect(container.getByRole('textbox', { name })).toHaveValue(value, { timeout: 10_000 })
}

test.describe('Setup script import prompt', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
  })

  test('imports Superset local overlays through the prompt UI', async ({ orcaPage }, testInfo) => {
    const repoPath = createSupersetSetupRepo(testInfo.outputPath('superset-setup-repo'))
    const repoId = await addAndActivateRepo(orcaPage, repoPath)

    await expect(
      orcaPage.getByText(
        /Found a setup command in\s*Superset \(\.superset\/config\.json \+1\)\. Save it to run for new worktrees\./
      )
    ).toBeVisible({ timeout: 15_000 })

    await orcaPage.getByRole('button', { name: 'Save local setup' }).click()

    await expect(
      orcaPage.getByText('2 unsupported fields skipped. Saved the setup command.')
    ).toBeVisible()

    const localCommands = await openImportedSetupSettingsFromToast(orcaPage, repoId)
    await expectSettingsCommandValue(
      localCommands,
      'Setup Script',
      'corepack enable\nbun install\nbun run db:migrate'
    )
    await expectSettingsCommandValue(
      localCommands,
      'Archive Script',
      'docker compose down --remove-orphans'
    )
  })

  test('imports cmux setup commands through the prompt UI', async ({ orcaPage }, testInfo) => {
    const repoPath = createCmuxSetupRepo(testInfo.outputPath('cmux-setup-repo'))
    const repoId = await addAndActivateRepo(orcaPage, repoPath)

    await expect(
      orcaPage.getByText(
        /Found a setup command in\s*cmux \(\.cmux\/cmux\.json\)\. Save it to run for new worktrees\./
      )
    ).toBeVisible({ timeout: 15_000 })

    await orcaPage.getByRole('button', { name: 'Save local setup' }).click()

    await expect(
      orcaPage.getByRole('button', { name: "project's settings", exact: true })
    ).toBeVisible()

    const repoSettings = await openRepoSettings(orcaPage, repoId)
    await expectSettingsCommandValue(repoSettings, 'Setup Script', './scripts/setup.sh')
    await expectSettingsCommandValue(repoSettings, 'Archive Script', '')
  })
})
