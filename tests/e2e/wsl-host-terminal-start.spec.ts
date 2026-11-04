/**
 * Terminals on a WSL host whose distro stopped, with a fake WSL transport: the HUB stands in for
 * the distro's orcad. Automatic retries never boot the distro (E9); the pane's Start and a New
 * Terminal are the user acting on it, so each boots it.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { createRuntimeDesktopPairingOffer } from './helpers/paired-electron-client'
import { callEnvironment } from './helpers/paired-host-terminal'
import { waitForSessionReady } from './helpers/store'
import {
  createGitProject,
  fakeWslConnects,
  focusProject,
  launchDesktopWithFakeWsl,
  readDistroState,
  RUNNING,
  STOPPED,
  WSL_ENVIRONMENT_ID,
  writeDistros
} from './helpers/wsl-host-fake-desktop'

async function openNewTerminal(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'New tab', exact: true }).first().click()
  await page
    .getByRole('menuitem', { name: /New Terminal/ })
    .first()
    .click()
}

test('a stopped WSL distro boots only for Start or New Terminal, never for a terminal retrying', async ({
  orcaPage: hub
}, testInfo) => {
  // Two Electron apps, a host add, two distro stops and their boots.
  test.setTimeout(300_000)
  await waitForSessionReady(hub)
  const offer = await createRuntimeDesktopPairingOffer(hub)
  const fakeDir = mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-wsl-terminal-fake-'))
  const distrosFile = path.join(fakeDir, 'distros.json')
  const connectLogFile = path.join(fakeDir, 'connects.log')
  writeDistros(distrosFile, RUNNING)
  const desktop = await launchDesktopWithFakeWsl(
    { distros: RUNNING, distrosFile, connectLogFile, pairingCode: offer.pairingUrl },
    testInfo
  )
  const projectPath = createGitProject()
  try {
    const { page } = desktop
    await page.evaluate(async () => {
      const settings = await window.api.settings.set({ experimentalWslHosts: true })
      window.__store?.setState({ settings })
    })
    const added = await page.evaluate(() =>
      window.api.runtimeEnvironments.wslHosts?.add({ distro: 'Ubuntu' })
    )
    expect(added, JSON.stringify(added)).toMatchObject({ ok: true })
    await callEnvironment(page, WSL_ENVIRONMENT_ID, 'repo.add', { path: projectPath, kind: 'git' })
    await expect.poll(() => focusProject(page, projectPath), { timeout: 60_000 }).toBeTruthy()

    const terminals = page.locator('.xterm')
    // The tab bar's own action, awaited: a New Terminal still in flight when the distro stops is a
    // user act and boots it, which is right but would land in the no-boot window below.
    const activeGroupId = (): Promise<string | null> =>
      page.evaluate(() => {
        const state = window.__store?.getState()
        const worktreeId = state?.activeWorktreeId
        return worktreeId
          ? (state.activeGroupIdByWorktree[worktreeId] ??
              state.groupsByWorktree[worktreeId]?.[0]?.id ??
              null)
          : null
      })
    await expect.poll(activeGroupId, { timeout: 60_000 }).not.toBeNull()
    const groupId = await activeGroupId()
    if (!groupId) {
      throw new Error('The WSL workspace has no tab group to open a terminal in')
    }
    await page.evaluate(
      (id) => window.__store?.getState().openNewTerminalTabInActiveWorkspace(id),
      groupId
    )
    await expect(page.locator('.xterm:visible')).toBeVisible({ timeout: 60_000 })

    const stopDistro = async (): Promise<number> => {
      const connects = fakeWslConnects(connectLogFile).length
      writeDistros(distrosFile, STOPPED)
      await expect
        .poll(
          () =>
            callEnvironment(page, WSL_ENVIRONMENT_ID, 'files.readDir', {
              worktree: `path:${projectPath}`,
              relativePath: ''
            }).then(
              () => 'answered',
              (error: unknown) => String(error)
            ),
          { timeout: 30_000 }
        )
        .toContain('Ubuntu was stopped')
      return connects
    }
    // The shown tab's card; a background tab's stays in the DOM, hidden.
    const stoppedCard = page.locator(
      `[data-terminal-wsl-host-stopped="${WSL_ENVIRONMENT_ID}"]:visible`
    )

    const connectsBeforeStart = await stopDistro()
    await expect(stoppedCard.first()).toBeVisible({ timeout: 60_000 })
    await expect(stoppedCard.first()).toContainText('Ubuntu is stopped')
    // Whatever the pane retries in the background must not boot the distro.
    // ast-grep-ignore: test-no-real-time-wait -- the claim is that nothing boots over a window of real retries
    await page.waitForTimeout(10_000)
    expect(fakeWslConnects(connectLogFile)).toHaveLength(connectsBeforeStart)
    expect(readDistroState(distrosFile)).toBe('stopped')
    await page.screenshot({ path: testInfo.outputPath('wsl-host-terminal-stopped.png') })

    await stoppedCard.first().getByRole('button', { name: 'Start', exact: true }).click()
    await expect
      .poll(() => fakeWslConnects(connectLogFile).length, { timeout: 60_000 })
      .toBe(connectsBeforeStart + 1)
    await expect(stoppedCard).toHaveCount(0, { timeout: 60_000 })
    // One Start is one connect: a second would rerun the server's launch in the distro.
    expect(fakeWslConnects(connectLogFile)).toHaveLength(connectsBeforeStart + 1)
    await page.screenshot({ path: testInfo.outputPath('wsl-host-terminal-after-start.png') })

    // New Terminal on the stopped host is the user acting on it too.
    const connectsBeforeNewTerminal = await stopDistro()
    await expect(stoppedCard.first()).toBeVisible({ timeout: 60_000 })
    const terminalCount = await terminals.count()
    await openNewTerminal(page)
    await expect
      .poll(() => fakeWslConnects(connectLogFile).length, { timeout: 60_000 })
      .toBe(connectsBeforeNewTerminal + 1)
    await expect.poll(() => terminals.count(), { timeout: 60_000 }).toBeGreaterThan(terminalCount)
    await expect(stoppedCard).toHaveCount(0, { timeout: 60_000 })
    expect(fakeWslConnects(connectLogFile)).toHaveLength(connectsBeforeNewTerminal + 1)
    await page.screenshot({ path: testInfo.outputPath('wsl-host-terminal-new-terminal.png') })
  } finally {
    await desktop.dispose()
    rmSync(fakeDir, { recursive: true, force: true })
    rmSync(projectPath, { recursive: true, force: true })
  }
})
