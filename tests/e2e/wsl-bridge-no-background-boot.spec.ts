/**
 * E9 guard on a real WSL distro: background work never starts a stopped distro. A project inside
 * the lane's distro is opened, the distro is terminated, and a window of ordinary background work
 * elsewhere must start nothing in it; the user then opening a terminal there starts it. Runs only
 * where ORCA_E2E_WSL_TERMINATE_DISTRO names a distro this run owns, since it terminates it.
 *
 * The running-list watcher is the authoritative assertion: `wsl --list --running`, polled through
 * the window, sees every boot, including a plain UNC read or git.exe with a UNC cwd. The spawn log
 * is diagnostics that name the caller: process-host spawns from any thread or inheriting child,
 * plus main's direct child_process spawns. It cannot see direct spawnSync calls outside
 * process-host (wsl-availability's missing-kernel `--exec /bin/true` is a documented exception)
 * or spawns in children that drop the environment.
 */
import { rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ElectronApplication, Page, TestInfo } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { waitForActivePanePtyId } from './helpers/terminal'
import { visitSettingsPanes } from './helpers/settings-pane-visits'
import { quotePosixShell } from '../../src/shared/shell-argument-quoting'
import {
  readDiagnosticLog,
  recordMainProcessWslDiagnostics
} from './helpers/wsl-boot-diagnostics-log'
import {
  activate,
  cycleWindowFocus,
  isDistroRunning,
  runInDistro,
  startsDistro,
  timeline,
  waitForWslLaunchesToSettle,
  watchDistroRunning,
  wsl
} from './helpers/wsl-boot-guard'

const DISTRO = process.env.ORCA_E2E_WSL_TERMINATE_DISTRO?.trim() ?? ''

/** Settings panes whose mount reads host, account, CLI or integration state. */
const SETTINGS_PANES = [
  'general',
  'integrations',
  'accounts',
  'agents',
  'git',
  'tasks',
  'session-history',
  'automations'
] as const

const SPAWN_LOG = path.join(os.tmpdir(), `orca-e2e-wsl-spawns-${process.pid}-${Date.now()}.jsonl`)
// Every process-host spawn in the app (main, worker threads, inheriting children) lands here.
test.use({ launchEnv: { ORCA_E2E_SPAWN_LOG: SPAWN_LOG } })

type WslWorkspace = { linuxRoot: string; worktreeId: string; repoId: string }

/** A git project inside the lane's distro, opened and focused while it runs, its terminal settled. */
async function openWslWorkspace(
  electronApp: ElectronApplication,
  page: Page
): Promise<WslWorkspace> {
  const linuxRoot = `/tmp/orca-e9-${Date.now()}`
  const repoLinuxPath = `${linuxRoot}/repo`
  await runInDistro(
    DISTRO,
    `mkdir -p ${quotePosixShell(`${repoLinuxPath}/src`)} && cd ${quotePosixShell(repoLinuxPath)} && ` +
      'git init -q -b main . && printf "# e9\\n" > README.md && printf "e9\\n" > src/main.txt && ' +
      'git add . && git -c user.name=e2e -c user.email=e2e@example.com commit -qm init'
  )
  const uncPath = `\\\\wsl.localhost\\${DISTRO}${repoLinuxPath.replaceAll('/', '\\')}`
  // Its sidebar card carries a linked issue and PR, whose refreshes must not start it either.
  const opened = await page.evaluate(async (path) => {
    const store = window.__store!
    const added = await window.api.repos.add({ path, kind: 'git' })
    if ('error' in added) {
      throw new Error(added.error)
    }
    await store.getState().fetchWorktrees(added.repo.id)
    const worktree = store
      .getState()
      .worktreesByRepo[added.repo.id]?.find((row) => row.isMainWorktree)
    if (!worktree) {
      throw new Error('WSL checkout missing')
    }
    await store.getState().updateWorktreeMeta(worktree.id, { linkedIssue: 1, linkedPR: 2 })
    return { worktreeId: worktree.id, repoId: added.repo.id }
  }, uncPath)
  // Focusing it opens a WSL terminal. Let that launch (its PTY, hook relay and agent probes)
  // finish before the terminate, or it boots the distro after it.
  await recordMainProcessWslDiagnostics(electronApp, SPAWN_LOG)
  await activate(page, opened.worktreeId)
  await ensureTerminalVisible(page, 60_000)
  await waitForActivePanePtyId(page, 60_000)
  await waitForWslLaunchesToSettle(SPAWN_LOG)
  timeline('WSL workspace terminal launched and settled')
  return { linuxRoot, ...opened }
}

/**
 * Terminates the distro, runs `window` once a read has seen it stopped, and fails if anything
 * started it meanwhile. Then the user opens a terminal there, which must start it.
 */
async function expectNothingStartsTheStoppedDistro(
  page: Page,
  testInfo: TestInfo,
  workspace: WslWorkspace,
  window: () => Promise<void>
): Promise<void> {
  // Counted from before the terminate, so work started while it stops counts too.
  const spawnsBefore = readDiagnosticLog(SPAWN_LOG).length
  timeline('terminate')
  await wsl(['--terminate', DISTRO], 30_000)
  timeline('terminated')
  // WSL1 instances can live only seconds, so watch the running list from the terminate on.
  const watcher = watchDistroRunning(DISTRO, SPAWN_LOG, {
    spawnsBefore,
    retryTerminate: async () => {
      await wsl(['--terminate', DISTRO], 30_000)
      timeline('terminated (retry)')
    }
  })
  let watched: { seenRunning: boolean; reads: number } | undefined
  try {
    // The window starts only once a read has seen it stopped, within the grace.
    await watcher.stopped
    timeline('confirmed stopped')
    await window()
    await page.screenshot({ path: testInfo.outputPath('wsl-bridge-background-window.png') })
    // ast-grep-ignore: test-no-real-time-wait -- the claim is that nothing boots over a window of real background work
    await page.waitForTimeout(15_000)
  } finally {
    watched = await watcher.stop()
  }
  // Authoritative: the distro never ran during the window.
  expect(watched.reads).toBeGreaterThan(10)
  expect(watched.seenRunning).toBe(false)
  expect(await isDistroRunning(DISTRO)).toBe(false)
  // Diagnostics that name the caller; non-empty so the check cannot pass vacuously.
  const background = readDiagnosticLog(SPAWN_LOG).slice(spawnsBefore)
  expect(background.length).toBeGreaterThan(0)
  expect(background.filter((spawn) => startsDistro(spawn, DISTRO))).toEqual([])

  timeline(`window done: ${background.length} spawns`)
  // The user opens the WSL workspace and a terminal in it: that act starts the distro.
  await activate(page, workspace.worktreeId)
  await page.getByRole('button', { name: 'New tab', exact: true }).first().click()
  await page
    .getByRole('menuitem', { name: /New Terminal/ })
    .first()
    .click()
  await expect(page.locator('.xterm:visible').first()).toBeVisible({ timeout: 60_000 })
  await expect.poll(() => isDistroRunning(DISTRO), { timeout: 60_000 }).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('wsl-bridge-after-terminal.png') })
}

async function removeWslWorkspace(workspace: WslWorkspace | undefined): Promise<void> {
  if (workspace) {
    await runInDistro(DISTRO, `rm -rf ${quotePosixShell(workspace.linuxRoot)}`).catch(
      (error: unknown) => timeline(`cleanup failed: ${String(error)}`)
    )
  }
  rmSync(SPAWN_LOG, { force: true })
}

test.describe('E9: background work on a stopped real WSL distro', () => {
  test.skip(
    process.platform !== 'win32' || !DISTRO,
    'Needs a Windows run that owns a WSL distro it may terminate (ORCA_E2E_WSL_TERMINATE_DISTRO)'
  )

  test('starts nothing in the stopped distro until the user opens a terminal there', async ({
    electronApp,
    orcaPage: page
  }, testInfo) => {
    // Distro setup, a terminate, a 20 s background window and a boot.
    test.setTimeout(300_000)
    await waitForSessionReady(page)
    const localWorktreeId = await waitForActiveWorktree(page)
    let workspace: WslWorkspace | undefined
    try {
      workspace = await openWslWorkspace(electronApp, page)
      const { repoId } = workspace
      await activate(page, localWorktreeId)
      await expectNothingStartsTheStoppedDistro(page, testInfo, workspace, async () => {
        for (let round = 0; round < 2; round += 1) {
          timeline(`round ${round}: focus and workspace switches`)
          await cycleWindowFocus(page)
          await activate(page, null)
          await cycleWindowFocus(page)
          await activate(page, localWorktreeId)
          timeline(`round ${round}: settings`)
          await visitSettingsPanes(page, SETTINGS_PANES, repoId)
          timeline(`round ${round}: tasks and account switches`)
          await page.evaluate(() => window.__store?.getState().setActiveView('tasks'))
          await page.evaluate(async () => {
            // Account switches re-sync every account home, including WSL ones.
            await window.api.codexAccounts.select({ accountId: null }).catch(() => {})
            await window.api.claudeAccounts.select({ accountId: null }).catch(() => {})
          })
          await page.evaluate(() => window.__store?.getState().setActiveView('terminal'))
        }
      })
    } finally {
      await removeWslWorkspace(workspace)
    }
  })

  test('a focused WSL workspace left idle through the stop never starts it again', async ({
    electronApp,
    orcaPage: page
  }, testInfo) => {
    // Distro setup, an Explorer and Source Control load, a terminate, a 22.5 s idle and a boot.
    test.setTimeout(300_000)
    await waitForSessionReady(page)
    let workspace: WslWorkspace | undefined
    try {
      workspace = await openWslWorkspace(electronApp, page)
      // The user's view: the Explorer with a folder expanded, then Source Control.
      await page.evaluate(() => {
        const state = window.__store?.getState()
        state?.setRightSidebarOpen(true)
        state?.setRightSidebarTab('explorer')
      })
      const row = (name: string) =>
        page
          .locator('[data-file-explorer-row]')
          .filter({ has: page.getByText(name, { exact: true }) })
      await row('src').click()
      await expect(row('main.txt')).toBeVisible({ timeout: 30_000 })
      await page.evaluate(() => window.__store?.getState().setRightSidebarTab('source-control'))
      await waitForWslLaunchesToSettle(SPAWN_LOG)
      timeline('focused: explorer expanded, source control shown')
      // Nothing more from the user: the stop's own fallout (bridge exit, watcher stop, host loss and
      // the re-renders they cause) is all that runs, half with Explorer and half with Source Control.
      await expectNothingStartsTheStoppedDistro(page, testInfo, workspace, async () => {
        await page.evaluate(() => window.__store?.getState().setRightSidebarTab('explorer'))
        // ast-grep-ignore: test-no-real-time-wait -- the Explorer must sit visible while the stop lands
        await page.waitForTimeout(7_500)
        timeline('idle: source control shown')
        await page.evaluate(() => window.__store?.getState().setRightSidebarTab('source-control'))
      })
    } finally {
      await removeWslWorkspace(workspace)
    }
  })
})
