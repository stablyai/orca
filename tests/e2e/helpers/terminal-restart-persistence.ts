import { readFileSync, existsSync } from 'node:fs'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { test, expect } from './orca-app'
import { TEST_REPO_PATH_FILE } from '../global-setup'
import { attachRepoAndOpenTerminal } from './orca-restart'
import { discoverActivePtyId, waitForActiveTerminalManager, waitForPaneCount } from './terminal'
import {
  waitForSessionReady,
  waitForActiveWorktree,
  getActiveWorktreeId,
  getActiveTabId,
  ensureTerminalVisible
} from './store'

const REQUIRE_WINDOWS_TERMINAL_RESTART_E2E =
  process.env.ORCA_REQUIRE_WINDOWS_TERMINAL_RESTART_E2E === '1'
const MISSING_SEEDED_REPO_MESSAGE = 'Global setup did not produce a seeded test repo'

export function seededRepoPathOrSkip(): string {
  const repoPath = existsSync(TEST_REPO_PATH_FILE)
    ? readFileSync(TEST_REPO_PATH_FILE, 'utf-8').trim()
    : ''
  const unavailable = !repoPath || !existsSync(repoPath)
  if (unavailable && REQUIRE_WINDOWS_TERMINAL_RESTART_E2E) {
    throw new Error('Required Windows restart E2E seeded repo is unavailable')
  }
  test.skip(unavailable, MISSING_SEEDED_REPO_MESSAGE)
  return repoPath
}

/**
 * Shared bootstrap for a *first* launch: attach the seeded test repo,
 * activate its worktree, ensure a terminal is mounted, and return the
 * PTY id we can drive with `execInTerminal`.
 *
 * Why: every test in this file needs the exact same starting state on the
 * first launch. Inlining it would obscure the thing each test is actually
 * asserting about the *second* launch.
 */
export async function bootstrapFirstLaunch(
  page: Page,
  repoPath: string
): Promise<{ worktreeId: string; ptyId: string }> {
  const worktreeId = await attachRepoAndOpenTerminal(page, repoPath)
  await waitForSessionReady(page)
  await waitForActiveWorktree(page)
  await ensureTerminalVisible(page)

  const hasPaneManager = await waitForActiveTerminalManager(page, 30_000)
    .then(() => true)
    .catch(() => false)
  if (!hasPaneManager && REQUIRE_WINDOWS_TERMINAL_RESTART_E2E) {
    throw new Error('Required Windows restart E2E TerminalPane manager did not mount')
  }
  test.skip(
    !hasPaneManager,
    'Electron automation in this environment never mounts the TerminalPane manager, so restart-persistence assertions would only fail on harness setup.'
  )
  await waitForPaneCount(page, 1, 30_000)

  const ptyId = await discoverActivePtyId(page)
  return { worktreeId, ptyId }
}

/**
 * Shared bootstrap for a *second* launch: just wait for the session to
 * restore, and confirm the previously-active worktree is the active one
 * again so downstream assertions operate against the right worktree.
 */
export async function bootstrapRestoredLaunch(
  page: Page,
  expectedWorktreeId: string
): Promise<void> {
  await waitForSessionReady(page)
  await expect
    .poll(async () => getActiveWorktreeId(page), { timeout: 10_000 })
    .toBe(expectedWorktreeId)
  await ensureTerminalVisible(page)
  // Why: the PaneManager remounts asynchronously after session hydration. The
  // restored terminal surface is what we're about to assert against, so make
  // sure it exists before any content/layout assertion races.
  await waitForActiveTerminalManager(page, 30_000)
  await waitForPaneCount(page, 1, 30_000)
}

export async function setPaneTitleFromTerminalMenu(page: Page, title: string): Promise<void> {
  const modifiers: ('Alt' | 'Control' | 'Meta' | 'Shift')[] =
    process.platform === 'win32' ? ['Control'] : []
  await page
    .locator('.xterm:visible')
    .first()
    .click({ button: 'right', position: { x: 40, y: 40 }, modifiers })
  await page.getByText('Set Title…', { exact: true }).click()
  const titleInput = page.locator('.pane-title-input').first()
  await expect(titleInput).toBeVisible()
  await titleInput.fill(title)
  await titleInput.press('Enter')
}

export async function getTabCustomTitle(
  page: Page,
  worktreeId: string,
  tabId: string
): Promise<string | null> {
  return page.evaluate(
    ({ targetWorktreeId, targetTabId }) => {
      const state = window.__store!.getState()
      const tab = (state.tabsByWorktree[targetWorktreeId] ?? []).find(
        (entry) => entry.id === targetTabId
      )
      return tab?.customTitle ?? null
    },
    { targetWorktreeId: worktreeId, targetTabId: tabId }
  )
}

export async function readTerminalActiveLine(page: Page): Promise<string | null> {
  const tabId = await getActiveTabId(page)
  if (!tabId) {
    return null
  }
  return page.evaluate((tabId) => {
    const manager = window.__paneManagers?.get(tabId)
    const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
    const buffer = pane?.terminal?.buffer.active
    if (!buffer) {
      return null
    }
    const cursorLine = buffer.baseY + buffer.cursorY
    return buffer.getLine(cursorLine)?.translateToString(true) ?? null
  }, tabId)
}

export async function waitForTerminalActiveLine(page: Page, expectedText: string): Promise<string> {
  await expect
    .poll(async () => (await readTerminalActiveLine(page))?.includes(expectedText), {
      timeout: 15_000,
      message: `Terminal cursor line did not contain "${expectedText}"`
    })
    .toBe(true)

  const activeLine = await readTerminalActiveLine(page)
  if (activeLine === null) {
    throw new Error('Terminal cursor line disappeared after settling')
  }
  return activeLine
}

export async function waitForElectronProcessExit(app: ElectronApplication): Promise<void> {
  const process = app.process()
  if (process.exitCode !== null || process.signalCode !== null) {
    return
  }
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      process.off('exit', onExit)
      reject(new Error('Electron profile-switch relaunch did not exit'))
    }, 15_000)
    const onExit = (): void => {
      clearTimeout(timeout)
      process.off('exit', onExit)
      resolve()
    }
    process.once('exit', onExit)
  })
}

export async function expectSavedLayoutToContainTitle(
  page: Page,
  tabId: string,
  title: string
): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(
          ({ targetTabId, title }) => {
            const layout = window.__store!.getState().terminalLayoutsByTabId[targetTabId]
            return Object.values(layout?.titlesByLeafId ?? {}).includes(title)
          },
          { targetTabId: tabId, title }
        ),
      { timeout: 3_000 }
    )
    .toBe(true)
}
