// #461’s 3-minute renderer scrollback serialization caused multi-pane input stalls; #729 replaced it with daemon history and pruned local session buffers.
// Require daemon-backed clean-restart scrollback/layout and infrequent idle session writes.
// Short idle sampling catches frequent writers, not the original 3-minute cadence; crash recovery and machine-dependent input lag have separate coverage.

import type { ElectronApplication } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import {
  execInTerminal,
  waitForTerminalOutput,
  waitForPaneCount,
  getTerminalContent,
  splitActiveTerminalPane
} from './helpers/terminal'
import { getActiveTabId, getWorktreeTabs } from './helpers/store'
import { createRestartSession } from './helpers/orca-restart'
import { PTY_SESSION_ID_SEPARATOR } from '../../src/shared/pty-session-id-format'
import {
  seededRepoPathOrSkip,
  bootstrapFirstLaunch,
  bootstrapRestoredLaunch,
  waitForTerminalActiveLine,
  readTerminalActiveLine,
  setPaneTitleFromTerminalMenu,
  getTabCustomTitle,
  expectSavedLayoutToContainTitle
} from './helpers/terminal-restart-persistence'

// Serialize full quit/relaunch cycles to avoid competing Electron cache locks.
test.describe.configure({ mode: 'serial' })

test.describe('Terminal restart persistence', () => {
  test('scrollback survives clean quit and relaunch', async (// oxlint-disable-next-line no-empty-pattern -- Playwright's second fixture arg is testInfo; the first must be an object destructure to opt out of the default fixture set.
  {}, testInfo) => {
    const repoPath = seededRepoPathOrSkip()

    const session = createRestartSession(testInfo)
    let firstApp: ElectronApplication | null = null
    let secondApp: ElectronApplication | null = null

    try {
      const firstLaunch = await session.launch()
      firstApp = firstLaunch.app
      const { worktreeId, ptyId } = await bootstrapFirstLaunch(firstLaunch.page, repoPath)
      // Require daemon-backed persistence; LocalPtyProvider fallback intentionally prunes buffers and would give the wrong failure signal.
      expect(ptyId).toContain(PTY_SESSION_ID_SEPARATOR)

      // Use a retry-unique marker plus newline so prompt/OSC residue cannot satisfy snapshot retention.
      const marker = `SCROLLBACK_PERSIST_${Date.now()}`
      await execInTerminal(firstLaunch.page, ptyId, `echo ${marker}`)
      await waitForTerminalOutput(firstLaunch.page, marker)

      // Close saves session bindings and disconnects; daemon retains scrollback.
      await session.close(firstApp)
      firstApp = null

      const secondLaunch = await session.launch()
      secondApp = secondLaunch.app
      await bootstrapRestoredLaunch(secondLaunch.page, worktreeId)

      // Poll live xterm after snapshot replay; local scrollback is intentionally absent from store.
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
    const repoPath = seededRepoPathOrSkip()

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
      const promptCommand =
        process.platform === 'win32'
          ? `function global:prompt { '${prompt}' }`
          : `export PS1='${prompt}'; PROMPT='${prompt}'`
      // PowerShell prompt is a function; keep PS1/PROMPT for Bash/Zsh.
      await execInTerminal(firstLaunch.page, ptyId, promptCommand)
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

      await expect
        .poll(
          async () => {
            const activeLine = await readTerminalActiveLine(secondLaunch.page)
            if (!activeLine || activeLine.includes(marker)) {
              return false
            }
            // Require a settled prompt, not the temporary PS1 surviving: reattach may preserve the shell or replay before a new prompt.
            return activeLine === beforeActiveLine || /[$#%>]\s*$/.test(activeLine)
          },
          {
            timeout: 10_000,
            message: 'Restored terminal cursor did not settle on a shell prompt line'
          }
        )
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

  test('active worktree and terminal tab count survive restart', async (// oxlint-disable-next-line no-empty-pattern -- Playwright's second fixture arg is testInfo; the first must be an object destructure to opt out of the default fixture set.
  {}, testInfo) => {
    const repoPath = seededRepoPathOrSkip()

    const session = createRestartSession(testInfo)
    let firstApp: ElectronApplication | null = null
    let secondApp: ElectronApplication | null = null

    try {
      const firstLaunch = await session.launch()
      firstApp = firstLaunch.app
      const { worktreeId } = await bootstrapFirstLaunch(firstLaunch.page, repoPath)

      // Create a second tab via the shortcut’s store path to give layout state beyond the default without focus timing.
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

      const secondLaunch = await session.launch()
      secondApp = secondLaunch.app
      await bootstrapRestoredLaunch(secondLaunch.page, worktreeId)

      // Count tabs: renderer remints ids on launch while persistence keeps positions.
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
    const repoPath = seededRepoPathOrSkip()

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
    const repoPath = seededRepoPathOrSkip()

    const session = createRestartSession(testInfo)
    let app: ElectronApplication | null = null

    try {
      const { app: launchedApp, page } = await session.launch()
      app = launchedApp
      await bootstrapFirstLaunch(page, repoPath)

      // Count session.set over 10s to catch frequent background writes; a loose threshold tolerates startup/store activity without waiting three minutes.
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
