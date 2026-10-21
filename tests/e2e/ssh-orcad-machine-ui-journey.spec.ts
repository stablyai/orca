/**
 * The Machines UI end to end against real Docker SSH hosts: create a machine from the composer's
 * Run-on picker and watch its stages, sleep it from the worktree's machine menu, reload and open
 * the worktree so wake-on-open brings its terminal back, then delete it through the Delete dialog.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import {
  DOCKER_MACHINE_PROVIDER_KEY,
  dockerMachineProviderEnv,
  installDockerMachineProvider,
  isDockerMachineRunning,
  machineSnapshot,
  prepareDockerMachineProvider,
  type DockerMachineProvider
} from './helpers/docker-machine-provider'
import {
  ORCAD_TEMPLATE,
  expectTerminalAnswers,
  skipUnlessManagedDockerHost,
  terminalTabIds,
  waitForPane
} from './helpers/orcad-managed-workspace'
import { openSidebarWorkspaceComposer } from './helpers/sidebar-project-dialog'
import { waitForSessionReady } from './helpers/store'

// A bare repo each fixture machine seeds and serves, so the project really clones there. A generic (non-GitHub)
// remote on purpose: the project links into the machine through its Git remote alone.
const ORIGIN_URL = 'git://127.0.0.1/orca-e2e-origin.git'
const WORKTREE_NAME = 'ui-journey'

skipUnlessManagedDockerHost()
test.skip(process.platform === 'win32', 'The fixture provider drives the Docker CLI on POSIX hosts')
test.use({
  seedTestRepo: false,
  orcaAppExtraEnv: { ORCA_ORCAD_TEMPLATE_PATH: ORCAD_TEMPLATE ?? '', ...dockerMachineProviderEnv() }
})

function createProjectRepo(): string {
  // Real path: the app records the resolved path, which differs under macOS's /var symlink.
  const repo = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-machine-project-')))
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' })
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'e2e@test.local')
  git('config', 'user.name', 'Orca Machine E2E')
  writeFileSync(path.join(repo, 'README.md'), 'e2e\n')
  git('add', 'README.md')
  git('commit', '-qm', 'initial')
  git('remote', 'add', 'origin', ORIGIN_URL)
  return repo
}

async function addProject(page: Page, repo: string): Promise<void> {
  await page.evaluate(async (repoPath) => {
    const result = await window.api.repos.add({ path: repoPath })
    if ('error' in result) {
      throw new Error(result.error)
    }
  }, repo)
  await expect
    .poll(
      () =>
        page.evaluate(async (repoPath) => {
          await window.__store
            ?.getState()
            .fetchRepos({ runtimeEnvironmentId: null, throwOnError: true })
          return (
            window.__store?.getState().repos.find((candidate) => candidate.path === repoPath)
              ?.gitRemoteIdentity?.remoteUrl ?? null
          )
        }, repo),
      { timeout: 30_000, message: 'the project never read its clone URL' }
    )
    .toBe(ORIGIN_URL)
}

function worktreeRow(page: Page) {
  return page.locator('[role="option"]').filter({ hasText: WORKTREE_NAME }).first()
}

/** The worktree's machine submenu in its sidebar context menu, open. */
async function openMachineMenu(page: Page, machineName: string) {
  await worktreeRow(page).click({ button: 'right' })
  await page.getByRole('menuitem', { name: machineName }).hover()
  return page.getByRole('menu').last()
}

async function machineState(page: Page): Promise<string | null> {
  return (await machineSnapshot(page))?.machines[0]?.state ?? null
}

async function activeTerminalTab(page: Page): Promise<string> {
  let tabId: string | undefined
  await expect
    .poll(
      async () => {
        const worktreeId = await page.evaluate(() => window.__store?.getState().activeWorktreeId)
        tabId = worktreeId ? (await terminalTabIds(page, worktreeId))[0] : undefined
        return tabId ?? null
      },
      { timeout: 60_000, message: 'the worktree never opened a terminal' }
    )
    .not.toBeNull()
  await waitForPane(page, tabId!)
  return tabId!
}

/** Waits until no machine creation is pending; a failed one throws with its log. */
async function expectCreationSettled(page: Page): Promise<void> {
  await expect
    .poll(
      async () => {
        const pending = await page.evaluate(() =>
          Object.values(window.__store?.getState().pendingWorktreeCreations ?? {}).map((entry) => ({
            status: entry.status,
            error: entry.error,
            log: entry.provisioningLog
          }))
        )
        const failed = pending.find((entry) => entry.status === 'error')
        if (failed) {
          throw new Error(`Machine creation failed: ${failed.error}\n${failed.log ?? ''}`)
        }
        return pending.length
      },
      { timeout: 300_000, message: 'the machine creation never finished' }
    )
    .toBe(0)
}

test('creates a machine from the composer, wakes it on open and deletes it', async ({
  orcaPage
}) => {
  // Create deploys the machine's managed server; wake restarts it.
  test.setTimeout(600_000)
  let provider: DockerMachineProvider | null = null
  const repo = createProjectRepo()
  try {
    provider = prepareDockerMachineProvider()
    await waitForSessionReady(orcaPage)
    await installDockerMachineProvider(orcaPage, provider.pluginDir)
    await addProject(orcaPage, repo)

    // Composer: Run on → New machine on Docker machines…, Temporary.
    await openSidebarWorkspaceComposer(orcaPage)
    const composer = orcaPage.getByRole('dialog', { name: /Create (Workspace|Worktree)/i })
    await composer.getByPlaceholder(/Type a name/i).fill(WORKTREE_NAME)
    // No agent: the fixture machine has none installed, and the journey needs only a shell.
    await composer.getByRole('button', { name: 'Clear agent selection' }).click()
    await composer.getByRole('combobox', { name: 'Run on' }).click()
    await orcaPage.getByRole('option', { name: 'New machine on Docker machines…' }).click()
    await composer.getByRole('button', { name: 'Advanced' }).click()
    await composer.getByRole('radio', { name: 'Temporary' }).click()
    await composer.getByRole('button', { name: /Create (Workspace|Worktree)/i }).click()

    // Stages: the machine starts, the project clones onto it, and the worktree opens.
    const stages = orcaPage.locator('[data-machine-stages]')
    await expect(stages).toBeVisible({ timeout: 30_000 })
    await expect(stages.locator('[data-stage="starting-machine"]')).toHaveAttribute(
      'data-state',
      'done',
      { timeout: 300_000 }
    )
    await expectCreationSettled(orcaPage)
    const tabId = await activeTerminalTab(orcaPage)
    await expectTerminalAnswers(orcaPage, tabId)
    const machine = (await machineSnapshot(orcaPage))?.machines[0]
    expect(machine).toMatchObject({ state: 'running', lifetime: 'temporary' })
    const container = provider.containerFor(machine!.id)
    expect(container).not.toBeNull()

    // Machine menu: Sleep machine stops the container.
    const menu = await openMachineMenu(orcaPage, machine!.name)
    await menu.getByRole('menuitem', { name: 'Sleep machine' }).click()
    await expect.poll(() => machineState(orcaPage), { timeout: 120_000 }).toBe('sleeping')
    expect(isDockerMachineRunning(container!)).toBe(false)

    // Wake on open: after a reload, opening the worktree wakes the machine and the terminal answers.
    await orcaPage.reload()
    await waitForSessionReady(orcaPage)
    await worktreeRow(orcaPage).click()
    await expect.poll(() => machineState(orcaPage), { timeout: 240_000 }).toBe('running')
    // The same terminal tab reattaches; a fresh one would hide a lost session.
    expect(await activeTerminalTab(orcaPage)).toBe(tabId)
    // The wake hold covers the pane until its session is live; keys typed under it are dropped.
    await expect(orcaPage.locator('[data-terminal-machine-wake-hold]')).toHaveCount(0, {
      timeout: 60_000
    })
    await expectTerminalAnswers(orcaPage, tabId, 180_000)
    // Back without a hold, an error toast or a stopped-machine banner left on the pane.
    await expect(orcaPage.locator('[data-terminal-machine-wake-hold]')).toHaveCount(0)
    await expect(orcaPage.locator('[data-terminal-error-toast]')).toHaveCount(0)
    await expect(orcaPage.locator('[data-terminal-stopped-machine-banner]')).toHaveCount(0)

    // Delete dialog: removes the machine and its worktree.
    const deleteMenu = await openMachineMenu(orcaPage, machine!.name)
    await deleteMenu.getByRole('menuitem', { name: 'Delete…' }).click()
    const dialog = orcaPage.getByRole('dialog', { name: `Delete ${machine!.name}` })
    // The clone holds nothing; the new worktree's branch was never pushed, which is work at risk.
    await expect
      .poll(async () => (await dialog.locator('[data-at-risk]').allTextContents()).toSorted(), {
        timeout: 30_000
      })
      .toEqual(['Never pushed', 'No changes'])
    await dialog.getByRole('button', { name: 'Delete machine and 2 worktrees' }).click()
    await expect(dialog).toBeHidden({ timeout: 120_000 })
    await expect.poll(() => provider!.containerFor(machine!.id), { timeout: 60_000 }).toBeNull()
    await expect(worktreeRow(orcaPage)).toBeHidden({ timeout: 60_000 })
    const remaining = await machineSnapshot(orcaPage)
    expect(remaining?.providerKey).toBe(DOCKER_MACHINE_PROVIDER_KEY)
    expect(remaining?.machines.filter((row) => row.state !== 'gone')).toEqual([])
  } finally {
    provider?.cleanup()
    rmSync(repo, { recursive: true, force: true })
  }
})
