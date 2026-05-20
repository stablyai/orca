/* eslint-disable max-lines -- Restart persistence E2E covers separate lifecycle regressions that need real relaunches. */
/**
 * E2E tests for terminal scrollback persistence across clean app restarts.
 *
 * Why this suite exists:
 *   PR #461 added a 3-minute periodic interval that re-serialized every
 *   mounted TerminalPane's scrollback so an unclean exit (crash, SIGKILL)
 *   wouldn't lose in-session output. With many panes of accumulated output,
 *   each tick blocked the renderer main thread for seconds, causing visible
 *   input lag across the whole app. The periodic save was removed in favor
 *   of the out-of-process terminal daemon (PR #729), and local renderer
 *   scrollback buffers are pruned from persisted workspace sessions. This
 *   suite locks down daemon-backed clean quit → relaunch so we don't silently
 *   return to "quit → empty terminal on relaunch."
 *
 * What it covers:
 *   - Scrollback survives clean quit → relaunch (primary regression test).
 *   - Tab layout (active worktree, terminal tab count) survives restart.
 *   - Idle session writes stay infrequent (catches a reintroduced frequent
 *     interval before it ships; weaker than asserting the 3-minute cadence
 *     is gone, but doesn't require a minutes-long test run).
 *
 * What it does NOT try to cover:
 *   - Main-thread input-lag improvement — machine-dependent and flaky.
 *   - Crash/SIGKILL recovery — that is covered by daemon history checkpoints.
 */

import { readFileSync, existsSync } from 'fs'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { TEST_REPO_PATH_FILE } from './global-setup'
import {
  discoverActivePtyId,
  execInTerminal,
  waitForActiveTerminalManager,
  waitForTerminalOutput,
  waitForPaneCount,
  getTerminalContent,
  splitActiveTerminalPane
} from './helpers/terminal'
import {
  waitForSessionReady,
  waitForActiveWorktree,
  getActiveWorktreeId,
  getActiveTabId,
  getWorktreeTabs,
  ensureTerminalVisible
} from './helpers/store'
import { attachRepoAndOpenTerminal, createRestartSession } from './helpers/orca-restart'
import { PTY_SESSION_ID_SEPARATOR } from '../../src/shared/pty-session-id-format'

// Why: each test in this file does a full quit→relaunch cycle, which spawns
// two Electron instances back-to-back. Running in serial keeps the isolated
// userDataDirs from competing for the same Electron cache lock on cold start
// and keeps the failure mode interpretable when something goes wrong.
test.describe.configure({ mode: 'serial' })

/**
 * Shared bootstrap for a *first* launch: attach the seeded test repo,
 * activate its worktree, ensure a terminal is mounted, and return the
 * PTY id we can drive with `execInTerminal`.
 *
 * Why: every test in this file needs the exact same starting state on the
 * first launch. Inlining it would obscure the thing each test is actually
 * asserting about the *second* launch.
 */
async function bootstrapFirstLaunch(
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
async function bootstrapRestoredLaunch(page: Page, expectedWorktreeId: string): Promise<void> {
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

async function setPaneTitleFromTerminalMenu(page: Page, title: string): Promise<void> {
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

async function getTabCustomTitle(
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

async function readTerminalActiveLine(page: Page): Promise<string | null> {
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

async function waitForTerminalActiveLine(page: Page, expectedText: string): Promise<string> {
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

async function expectSavedLayoutToContainTitle(
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

test.describe('Terminal restart persistence', () => {
  test('scrollback survives clean quit and relaunch', async (// oxlint-disable-next-line no-empty-pattern -- Playwright's second fixture arg is testInfo; the first must be an object destructure to opt out of the default fixture set.
  {}, testInfo) => {
    const repoPath = readFileSync(TEST_REPO_PATH_FILE, 'utf-8').trim()
    if (!repoPath || !existsSync(repoPath)) {
      test.skip(true, 'Global setup did not produce a seeded test repo')
      return
    }

    const session = createRestartSession(testInfo)
    let firstApp: ElectronApplication | null = null
    let secondApp: ElectronApplication | null = null

    try {
      // ── First launch ────────────────────────────────────────────────
      const firstLaunch = await session.launch()
      firstApp = firstLaunch.app
      const { worktreeId, ptyId } = await bootstrapFirstLaunch(firstLaunch.page, repoPath)
      // Why: this spec validates the daemon-backed persistence path. If the
      // daemon falls back to LocalPtyProvider, local buffers are intentionally
      // pruned and the scrollback assertion would fail with the wrong signal.
      expect(ptyId).toContain(PTY_SESSION_ID_SEPARATOR)

      // Why: the marker must be distinctive enough that it can't appear in the
      // restored prompt banner or a stray OSC sequence. The timestamp suffix
      // keeps it unique across retries, and the trailing newline ensures the
      // buffer snapshot contains it on a line of its own.
      const marker = `SCROLLBACK_PERSIST_${Date.now()}`
      await execInTerminal(firstLaunch.page, ptyId, `echo ${marker}`)
      await waitForTerminalOutput(firstLaunch.page, marker)

      // Why: closing the app triggers the session save plus daemon disconnect.
      // The session keeps the PTY binding while the daemon keeps the scrollback.
      await session.close(firstApp)
      firstApp = null

      // ── Second launch ───────────────────────────────────────────────
      const secondLaunch = await session.launch()
      secondApp = secondLaunch.app
      await bootstrapRestoredLaunch(secondLaunch.page, worktreeId)

      // Why: daemon reattach replays its snapshot through xterm.write during
      // pane mount. Poll the live terminal content, not the store, because the
      // store intentionally no longer carries local scrollback buffers.
      await expect
        .poll(async () => (await getTerminalContent(secondLaunch.page)).includes(marker), {
          timeout: 15_000,
          message: 'Restored terminal did not contain the pre-quit scrollback marker'
        })
        .toBe(true)
    } finally {
      if (secondApp) {
        await session.close(secondApp)
      }
      if (firstApp) {
        await session.close(firstApp)
      }
      await session.dispose()
    }
  })

  test('daemon snapshot relaunch preserves the cursor on the shell prompt', async (// oxlint-disable-next-line no-empty-pattern -- Playwright's second fixture arg is testInfo; the first must be an object destructure to opt out of the default fixture set.
  {}, testInfo) => {
    const repoPath = readFileSync(TEST_REPO_PATH_FILE, 'utf-8').trim()
    if (!repoPath || !existsSync(repoPath)) {
      test.skip(true, 'Global setup did not produce a seeded test repo')
      return
    }

    const session = createRestartSession(testInfo)
    let firstApp: ElectronApplication | null = null
    let secondApp: ElectronApplication | null = null

    try {
      const firstLaunch = await session.launch()
      firstApp = firstLaunch.app
      const { worktreeId, ptyId } = await bootstrapFirstLaunch(firstLaunch.page, repoPath)
      expect(ptyId).toContain(PTY_SESSION_ID_SEPARATOR)

      const prompt = `ORCA_RESTART_PROMPT_${Date.now()}_GT `
      const marker = `ORCA_CURSOR_RESTART_${Date.now()}`
      await execInTerminal(firstLaunch.page, ptyId, `export PS1='${prompt}'; PROMPT='${prompt}'`)
      await waitForTerminalActiveLine(firstLaunch.page, prompt.trim())
      await execInTerminal(firstLaunch.page, ptyId, `echo ${marker}`)
      await waitForTerminalOutput(firstLaunch.page, marker)

      const beforeActiveLine = await waitForTerminalActiveLine(firstLaunch.page, prompt.trim())
      await session.close(firstApp)
      firstApp = null

      const secondLaunch = await session.launch()
      secondApp = secondLaunch.app
      await bootstrapRestoredLaunch(secondLaunch.page, worktreeId)
      await waitForTerminalOutput(secondLaunch.page, marker, 15_000)

      await expect.poll(() => readTerminalActiveLine(secondLaunch.page)).toBe(beforeActiveLine)
    } finally {
      if (secondApp) {
        await session.close(secondApp)
      }
      if (firstApp) {
        await session.close(firstApp)
      }
      await session.dispose()
    }
  })

  test('active worktree and terminal tab count survive restart', async (// oxlint-disable-next-line no-empty-pattern -- Playwright's second fixture arg is testInfo; the first must be an object destructure to opt out of the default fixture set.
  {}, testInfo) => {
    const repoPath = readFileSync(TEST_REPO_PATH_FILE, 'utf-8').trim()
    if (!repoPath || !existsSync(repoPath)) {
      test.skip(true, 'Global setup did not produce a seeded test repo')
      return
    }

    const session = createRestartSession(testInfo)
    let firstApp: ElectronApplication | null = null
    let secondApp: ElectronApplication | null = null

    try {
      // ── First launch ────────────────────────────────────────────────
      const firstLaunch = await session.launch()
      firstApp = firstLaunch.app
      const { worktreeId } = await bootstrapFirstLaunch(firstLaunch.page, repoPath)

      // Add a second terminal tab so the restart has layout state to restore
      // beyond "one default tab." createTab goes through the same store path
      // as the Cmd+T shortcut but doesn't depend on window focus timing.
      await firstLaunch.page.evaluate((worktreeId: string) => {
        const store = window.__store
        if (!store) {
          return
        }
        store.getState().createTab(worktreeId)
      }, worktreeId)

      await expect
        .poll(async () => (await getWorktreeTabs(firstLaunch.page, worktreeId)).length, {
          timeout: 5_000
        })
        .toBeGreaterThanOrEqual(2)

      const tabsBefore = await getWorktreeTabs(firstLaunch.page, worktreeId)

      await session.close(firstApp)
      firstApp = null

      // ── Second launch ───────────────────────────────────────────────
      const secondLaunch = await session.launch()
      secondApp = secondLaunch.app
      await bootstrapRestoredLaunch(secondLaunch.page, worktreeId)

      // Why: checking tab *count* (not ids) is the stable assertion — tab ids
      // are regenerated on each launch because the renderer mints them fresh,
      // while the persisted layout only carries the tab positions. Count
      // survives; id identity does not.
      await expect
        .poll(async () => (await getWorktreeTabs(secondLaunch.page, worktreeId)).length, {
          timeout: 10_000
        })
        .toBe(tabsBefore.length)
    } finally {
      if (secondApp) {
        await session.close(secondApp)
      }
      if (firstApp) {
        await session.close(firstApp)
      }
      await session.dispose()
    }
  })

  test('restored Set Title pane label survives agent title churn', async (// oxlint-disable-next-line no-empty-pattern -- Playwright's second fixture arg is testInfo; the first must be an object destructure to opt out of the default fixture set.
  {}, testInfo) => {
    const repoPath = readFileSync(TEST_REPO_PATH_FILE, 'utf-8').trim()
    if (!repoPath || !existsSync(repoPath)) {
      test.skip(true, 'Global setup did not produce a seeded test repo')
      return
    }

    const session = createRestartSession(testInfo)
    let firstApp: ElectronApplication | null = null
    let secondApp: ElectronApplication | null = null

    try {
      const firstLaunch = await session.launch()
      firstApp = firstLaunch.app
      const { worktreeId } = await bootstrapFirstLaunch(firstLaunch.page, repoPath)
      const title = `Restored pane label ${Date.now()}`
      const firstTabId = (await getActiveTabId(firstLaunch.page))!

      await setPaneTitleFromTerminalMenu(firstLaunch.page, title)
      await expect
        .poll(() => getTabCustomTitle(firstLaunch.page, worktreeId, firstTabId), {
          timeout: 3_000
        })
        .toBe(null)

      await session.close(firstApp)
      firstApp = null

      const secondLaunch = await session.launch()
      secondApp = secondLaunch.app
      await bootstrapRestoredLaunch(secondLaunch.page, worktreeId)
      const restoredTabId = (await getActiveTabId(secondLaunch.page))!

      await expect(secondLaunch.page.locator('.pane-title-text', { hasText: title })).toBeVisible()
      await expect
        .poll(() => getTabCustomTitle(secondLaunch.page, worktreeId, restoredTabId), {
          timeout: 3_000
        })
        .toBe(null)
      await expectSavedLayoutToContainTitle(secondLaunch.page, restoredTabId, title)

      const runtimeTitle = '⠋ Codex restored working'
      await secondLaunch.page.evaluate(
        ({ targetTabId, title }) => {
          window.__store!.getState().updateTabTitle(targetTabId, title)
        },
        { targetTabId: restoredTabId, title: runtimeTitle }
      )
      await expect(
        secondLaunch.page.locator(`[data-testid="sortable-tab"][data-tab-id="${restoredTabId}"]`)
      ).toHaveAttribute('data-tab-title', runtimeTitle)
      await expect(secondLaunch.page.locator('.pane-title-text', { hasText: title })).toBeVisible()
      await expect
        .poll(() => getTabCustomTitle(secondLaunch.page, worktreeId, restoredTabId), {
          timeout: 3_000
        })
        .toBe(null)

      await splitActiveTerminalPane(secondLaunch.page, 'vertical')
      await waitForPaneCount(secondLaunch.page, 2)
      await expect(secondLaunch.page.locator('.pane-title-text', { hasText: title })).toBeVisible()
    } finally {
      if (secondApp) {
        await session.close(secondApp)
      }
      if (firstApp) {
        await session.close(firstApp)
      }
      await session.dispose()
    }
  })

  test('idle session does not spam session.set writes', async (// oxlint-disable-next-line no-empty-pattern -- Playwright's second fixture arg is testInfo; the first must be an object destructure to opt out of the default fixture set.
  {}, testInfo) => {
    const repoPath = readFileSync(TEST_REPO_PATH_FILE, 'utf-8').trim()
    if (!repoPath || !existsSync(repoPath)) {
      test.skip(true, 'Global setup did not produce a seeded test repo')
      return
    }

    const session = createRestartSession(testInfo)
    let app: ElectronApplication | null = null

    try {
      const { app: launchedApp, page } = await session.launch()
      app = launchedApp
      await bootstrapFirstLaunch(page, repoPath)

      // Why: the periodic scrollback save that this branch removes was a
      // `session.set` call on every tick. Counting `session.set` calls over a
      // short idle window is a cheap proxy for "no high-frequency background
      // writer was reintroduced." The 10s window intentionally stays below the
      // per-test budget; the threshold is deliberately loose so normal user-
      // driven store activity (tab auto-create, worktree activation) doesn't
      // flake the test, while still catching an interval that fires every
      // couple of seconds.
      const callCount = await page.evaluate(async () => {
        const api = (
          window as unknown as { api: { session: { set: (...args: unknown[]) => unknown } } }
        ).api
        let count = 0
        const originalSet = api.session.set.bind(api.session)
        api.session.set = (...args: unknown[]) => {
          count += 1
          return originalSet(...args)
        }
        await new Promise((resolve) => setTimeout(resolve, 10_000))
        api.session.set = originalSet
        return count
      })

      expect(callCount).toBeLessThan(20)
    } finally {
      if (app) {
        await session.close(app)
      }
      await session.dispose()
    }
  })
})
