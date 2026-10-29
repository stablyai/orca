/**
 * E9 guard: background work never starts a stopped WSL distro. A desktop with a fake WSL transport
 * (the HUB stands in for the distro's orcad) keeps a WSL project and a local one. With the distro
 * stopped, a window of ordinary background activity elsewhere must start nothing in it; the user
 * then opening a terminal there starts it exactly once. Catches any new caller that skips the gate.
 * Host dials only; bridge/UNC background paths are covered by their unit gates and the Windows lane guard.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { expect } from './helpers/orca-app'
import { createRuntimeDesktopPairingOffer } from './helpers/paired-electron-client'
import { callEnvironment } from './helpers/paired-host-terminal'
import { buildFakeAgentCommandOverride } from './helpers/fake-agent-command-override'
import { SUPPORTED, test } from './helpers/structured-claude-stub'
import { waitForSessionReady } from './helpers/store'
import { visitSettingsPanes } from './helpers/settings-pane-visits'
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

/** Settings panes whose mount reads host, account, CLI or integration state. */
const SETTINGS_PANES = [
  'general',
  'integrations',
  'accounts',
  'agents',
  'git',
  'tasks',
  'servers',
  'session-history',
  'automations'
] as const

/** Adds a local checkout to the desktop and returns its main worktree. */
async function addLocalWorkspace(page: Page, repoPath: string): Promise<string> {
  return page.evaluate(async (repoPath) => {
    const store = window.__store!
    const added = await window.api.repos.add({ path: repoPath, kind: 'git' })
    if ('error' in added) {
      throw new Error(added.error)
    }
    await store.getState().fetchReposForAllHosts()
    await store.getState().fetchWorktrees(added.repo.id, { forceLocalOwner: true })
    const worktree = store
      .getState()
      .worktreesByRepo[added.repo.id]?.find((row) => row.isMainWorktree)
    if (!worktree) {
      throw new Error('Local checkout missing')
    }
    return worktree.id
  }, repoPath)
}

async function activateLocal(page: Page, worktreeId: string | null): Promise<void> {
  await page.evaluate((id) => window.__store?.getState().setActiveWorktree(id), worktreeId)
}

/** Window focus, blur and reveal, as alt-tabbing does, without raising any real window. */
async function cycleWindowFocus(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.dispatchEvent(new Event('blur'))
    document.dispatchEvent(new Event('visibilitychange'))
    window.dispatchEvent(new Event('focus'))
  })
}

test.describe('E9: background work on a stopped WSL host', () => {
  test.skip(!SUPPORTED, 'the Claude stub wrapper is POSIX-only')

  test('starts nothing in the stopped distro until the user opens a terminal there', async ({
    orcaPage: hub,
    claudeStub
  }, testInfo) => {
    // Two Electron apps, a host add, a chat turn and a 20 s background window.
    test.setTimeout(300_000)
    await waitForSessionReady(hub)
    const offer = await createRuntimeDesktopPairingOffer(hub)
    const fakeDir = mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-wsl-no-boot-fake-'))
    const distrosFile = path.join(fakeDir, 'distros.json')
    const connectLogFile = path.join(fakeDir, 'connects.log')
    writeDistros(distrosFile, RUNNING)
    const desktop = await launchDesktopWithFakeWsl(
      { distros: RUNNING, distrosFile, connectLogFile, pairingCode: offer.pairingUrl },
      testInfo
    )
    const wslProjectPath = createGitProject()
    const localProjectPath = createGitProject()
    try {
      const { page } = desktop
      await page.evaluate(async (claude) => {
        const settings = await window.api.settings.set({ experimentalWslHosts: true })
        window.__store?.setState({ settings })
        await window.__store?.getState().updateSettings({
          experimentalNativeChat: true,
          defaultTuiAgent: 'claude',
          agentCmdOverrides: { claude }
        })
      }, buildFakeAgentCommandOverride(claudeStub.command))
      const added = await page.evaluate(() =>
        window.api.runtimeEnvironments.wslHosts?.add({ distro: 'Ubuntu' })
      )
      expect(added, JSON.stringify(added)).toMatchObject({ ok: true })
      await callEnvironment(page, WSL_ENVIRONMENT_ID, 'repo.add', {
        path: wslProjectPath,
        kind: 'git'
      })
      await expect.poll(() => focusProject(page, wslProjectPath), { timeout: 60_000 }).toBeTruthy()
      const wslWorktreeId = await focusProject(page, wslProjectPath)
      if (!wslWorktreeId) {
        throw new Error('The WSL workspace never appeared')
      }
      // Its sidebar card carries a linked issue and PR, which refresh on their own.
      const linked = await page.evaluate(
        (id) => window.__store?.getState().updateWorktreeMeta(id, { linkedIssue: 1, linkedPR: 2 }),
        wslWorktreeId
      )
      expect(linked, JSON.stringify(linked)).toMatchObject({ ok: true })

      // A chat in another workspace keeps streaming while the WSL one sits stopped.
      const localWorktreeId = await addLocalWorkspace(page, localProjectPath)
      await activateLocal(page, localWorktreeId)
      await page.getByRole('button', { name: 'New tab', exact: true }).first().click()
      await page
        .getByRole('menu')
        .getByText('Claude', { exact: true })
        .first()
        .click({ timeout: 60_000 })
      const chat = page.locator('[data-native-chat-root="true"]:visible')
      await expect(chat).toBeVisible({ timeout: 60_000 })
      const send = async (text: string): Promise<void> => {
        const composer = chat.getByRole('textbox')
        await expect(composer).toBeEditable({ timeout: 60_000 })
        await composer.click()
        await page.keyboard.type(text)
        await chat.getByRole('button', { name: 'Send', exact: true }).click()
        const prompt = chat.locator('[data-native-chat-scroll]').getByText(text, { exact: true })
        await expect(
          prompt.last().locator('xpath=following::*[text()="Stub reply."]').first()
        ).toBeVisible({ timeout: 120_000 })
      }
      await send('before the distro stops')

      // Stop the distro, and wait until the desktop has seen it stop. The probe is a runtime call
      // itself, so a runtime path that forgets the gate already fails here by booting it.
      writeDistros(distrosFile, STOPPED)
      await expect
        .poll(
          () =>
            callEnvironment(page, WSL_ENVIRONMENT_ID, 'files.readDir', {
              worktree: `path:${wslProjectPath}`,
              relativePath: ''
            }).then(
              () => 'answered',
              (error: unknown) => String(error)
            ),
          { timeout: 30_000 }
        )
        .toContain('Ubuntu was stopped')
      const connectsWhileStopped = fakeWslConnects(connectLogFile).length
      // Setup connected at least once: a connect log that was never written fails here.
      expect(connectsWhileStopped).toBeGreaterThan(0)
      const wslRepoId = await page.evaluate(
        (wslPath) =>
          window.__store?.getState().repos.find((repo) => repo.path === wslPath)?.id ?? null,
        wslProjectPath
      )
      expect(wslRepoId).toBeTruthy()

      // The background window: nothing here is the user acting on the WSL workspace.
      for (let round = 0; round < 2; round += 1) {
        await cycleWindowFocus(page)
        await activateLocal(page, null)
        await cycleWindowFocus(page)
        await activateLocal(page, localWorktreeId)
        await visitSettingsPanes(page, SETTINGS_PANES, wslRepoId)
        await page.evaluate(() => window.__store?.getState().setActiveView('tasks'))
        await expect
          .poll(() => page.evaluate(() => window.__store?.getState().activeView))
          .toBe('tasks')
        await page.evaluate(async () => {
          // Account switches re-sync every host's homes; a stopped one must be skipped.
          await window.api.codexAccounts.select({ accountId: null }).catch(() => {})
          await window.api.claudeAccounts.select({ accountId: null }).catch(() => {})
        })
        await page.evaluate(() => window.__store?.getState().setActiveView('terminal'))
        await send(`while the distro is stopped ${round}`)
      }
      await page.screenshot({ path: testInfo.outputPath('wsl-no-boot-background-window.png') })
      // Timers, polls and retries keep running between the acts above; the claim is over real time.
      // ast-grep-ignore: test-no-real-time-wait -- the claim is that nothing boots over a window of real background work
      await page.waitForTimeout(15_000)
      expect(fakeWslConnects(connectLogFile)).toHaveLength(connectsWhileStopped)
      expect(readDistroState(distrosFile)).toBe('stopped')

      // The user opens a terminal in the WSL workspace: that act alone starts the distro, once.
      await expect.poll(() => focusProject(page, wslProjectPath), { timeout: 30_000 }).toBeTruthy()
      await page.getByRole('button', { name: 'New tab', exact: true }).first().click()
      await page
        .getByRole('menuitem', { name: /New Terminal/ })
        .first()
        .click()
      await expect(page.locator('.xterm:visible').first()).toBeVisible({ timeout: 60_000 })
      await expect
        .poll(() => fakeWslConnects(connectLogFile).length, { timeout: 60_000 })
        .toBe(connectsWhileStopped + 1)
      expect(readDistroState(distrosFile)).toBe('running')
      // ast-grep-ignore: test-no-real-time-wait -- a second start would land after the first; none may
      await page.waitForTimeout(5_000)
      expect(fakeWslConnects(connectLogFile)).toHaveLength(connectsWhileStopped + 1)
      await page.screenshot({ path: testInfo.outputPath('wsl-no-boot-after-terminal.png') })
    } finally {
      await desktop.dispose()
      rmSync(fakeDir, { recursive: true, force: true })
      rmSync(wslProjectPath, { recursive: true, force: true })
      rmSync(localProjectPath, { recursive: true, force: true })
    }
  })
})
