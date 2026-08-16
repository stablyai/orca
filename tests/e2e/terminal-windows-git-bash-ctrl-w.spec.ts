import type { Page } from '@stablyai/playwright-test'
import { WINDOWS_GIT_BASH_SHELL } from '../../src/shared/windows-terminal-shell'
import { test, expect } from './helpers/orca-app'
import {
  focusActiveTerminalInput,
  sendToTerminal,
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForTerminalOutput
} from './helpers/terminal'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  clearTerminalPtyWriteLog,
  installTerminalPtyWriteSpy,
  readTerminalPtyWrites
} from './helpers/terminal-pty-write-spy'

type WindowsShell = 'cmd.exe' | 'powershell.exe' | typeof WINDOWS_GIT_BASH_SHELL

async function createShellTab(
  page: Page,
  args: {
    globalShell: WindowsShell
    tabShell?: WindowsShell
    policy: 'terminal-first' | 'orca-first'
  }
): Promise<{ tabId: string; ptyId: string }> {
  const tabId = await page.evaluate(async (settings) => {
    const store = window.__store
    if (!store) {
      throw new Error('Store unavailable')
    }
    const worktreeId = store.getState().activeWorktreeId
    if (!worktreeId) {
      throw new Error('No active worktree')
    }
    await store.getState().updateSettings({
      terminalShortcutPolicy: settings.policy,
      terminalWindowsShell: settings.globalShell
    })
    const tab = store.getState().createTab(worktreeId, undefined, settings.tabShell)
    store.getState().setActiveTab(tab.id)
    store.getState().setActiveTabType('terminal')
    return tab.id
  }, args)

  await expect(page.locator(`[data-testid="sortable-tab"][data-tab-id="${tabId}"]`)).toBeVisible()
  await waitForActiveTerminalManager(page, 30_000)
  return { tabId, ptyId: await waitForActivePanePtyId(page, 30_000) }
}

async function activeTopology(
  page: Page,
  tabId: string
): Promise<{
  active: boolean
  exists: boolean
  paneCount: number
  ptyId: string | null
}> {
  return page.evaluate((targetTabId) => {
    const state = window.__store?.getState()
    const manager = window.__paneManagers?.get(targetTabId)
    const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
    const worktreeId = state?.activeWorktreeId
    return {
      active: state?.activeTabId === targetTabId,
      exists: Boolean(
        worktreeId && state?.tabsByWorktree[worktreeId]?.some((tab) => tab.id === targetTabId)
      ),
      paneCount: manager?.getPanes?.().length ?? 0,
      ptyId: pane?.container.dataset.ptyId ?? null
    }
  }, tabId)
}

async function settleTerminalClose(page: Page, tabId: string): Promise<void> {
  const confirmButton = page.getByRole('button', { name: /Stop and Close/i })
  await expect
    .poll(
      async () => {
        if (await confirmButton.isVisible().catch(() => false)) {
          await confirmButton.click()
        }
        return (await activeTopology(page, tabId)).exists
      },
      { timeout: 10_000, message: `Ctrl+W did not close terminal tab ${tabId}` }
    )
    .toBe(false)
}

async function pressCtrlWAndSettleClose(page: Page, tabId: string): Promise<void> {
  await focusActiveTerminalInput(page)
  await page.keyboard.press('Control+w')
  await settleTerminalClose(page, tabId)
}

test.describe('Windows Git Bash Ctrl+W ownership', () => {
  test.beforeEach(async ({ orcaPage }) => {
    test.skip(process.platform !== 'win32', 'Git Bash Ctrl+W coverage is Windows-only')
    test.skip(
      !(await orcaPage.evaluate(() => window.api.gitBash.isAvailable())),
      'Git Bash unavailable'
    )
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
  })

  test('Terminal-first global Git Bash keeps the tab and sends readline Ctrl+W', async ({
    electronApp,
    orcaPage
  }) => {
    const { tabId, ptyId } = await createShellTab(orcaPage, {
      globalShell: WINDOWS_GIT_BASH_SHELL,
      policy: 'terminal-first'
    })
    await installTerminalPtyWriteSpy(electronApp)
    await sendToTerminal(orcaPage, ptyId, 'echo CTRLW_BUFFER_alpha doomed')
    await waitForTerminalOutput(orcaPage, 'echo CTRLW_BUFFER_alpha doomed', 10_000)
    await clearTerminalPtyWriteLog(electronApp)

    await focusActiveTerminalInput(orcaPage)
    await orcaPage.keyboard.press('Control+w')

    await expect
      .poll(async () =>
        (await readTerminalPtyWrites(electronApp)).filter((data) => data === '\x17')
      )
      .toEqual(['\x17'])
    expect(await activeTopology(orcaPage, tabId)).toEqual({
      active: true,
      exists: true,
      paneCount: 1,
      ptyId
    })

    await orcaPage.keyboard.type('kept')
    await orcaPage.keyboard.press('Enter')
    await waitForTerminalOutput(orcaPage, 'CTRLW_BUFFER_alpha kept', 10_000)
  })

  test('Terminal-first honors an active Git Bash tab override over PowerShell', async ({
    electronApp,
    orcaPage
  }) => {
    const { tabId, ptyId } = await createShellTab(orcaPage, {
      globalShell: 'powershell.exe',
      tabShell: WINDOWS_GIT_BASH_SHELL,
      policy: 'terminal-first'
    })
    await installTerminalPtyWriteSpy(electronApp)
    await clearTerminalPtyWriteLog(electronApp)
    await focusActiveTerminalInput(orcaPage)
    await orcaPage.keyboard.press('Control+w')

    await expect
      .poll(async () =>
        (await readTerminalPtyWrites(electronApp)).filter((data) => data === '\x17')
      )
      .toEqual(['\x17'])
    expect(await activeTopology(orcaPage, tabId)).toEqual({
      active: true,
      exists: true,
      paneCount: 1,
      ptyId
    })
  })

  test('Orca-first Git Bash and Terminal-first native Windows shells keep pane-close ownership', async ({
    orcaPage
  }) => {
    const orcaFirst = await createShellTab(orcaPage, {
      globalShell: WINDOWS_GIT_BASH_SHELL,
      policy: 'orca-first'
    })
    await pressCtrlWAndSettleClose(orcaPage, orcaFirst.tabId)

    for (const shell of ['powershell.exe', 'cmd.exe'] as const) {
      const nativeShell = await createShellTab(orcaPage, {
        globalShell: shell,
        policy: 'terminal-first'
      })
      await pressCtrlWAndSettleClose(orcaPage, nativeShell.tabId)
    }
  })

  test('a logical w on physical KeyQ stays on the Orca pane-close path', async ({ orcaPage }) => {
    const { tabId } = await createShellTab(orcaPage, {
      globalShell: WINDOWS_GIT_BASH_SHELL,
      policy: 'terminal-first'
    })
    await focusActiveTerminalInput(orcaPage)
    await orcaPage.evaluate(() => {
      const textarea = document.activeElement
      if (!(textarea instanceof HTMLTextAreaElement)) {
        throw new Error('Active xterm textarea unavailable')
      }
      textarea.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'w',
          code: 'KeyQ',
          ctrlKey: true,
          bubbles: true,
          cancelable: true
        })
      )
    })
    await settleTerminalClose(orcaPage, tabId)
  })

  test('Terminal-first Git Bash keeps global Ctrl+W ownership on a non-terminal surface', async ({
    orcaPage
  }) => {
    const { tabId } = await createShellTab(orcaPage, {
      globalShell: WINDOWS_GIT_BASH_SHELL,
      policy: 'terminal-first'
    })
    await orcaPage.evaluate(() => {
      const state = window.__store?.getState()
      state?.setSettingsSearchQuery('')
      state?.openSettingsPage()
    })
    const search = orcaPage.getByPlaceholder('Search settings')
    await expect(search).toBeVisible()
    await search.focus()
    const defaultPrevented = await search.evaluate((input) => {
      const event = new KeyboardEvent('keydown', {
        key: 'w',
        code: 'KeyW',
        ctrlKey: true,
        bubbles: true,
        cancelable: true
      })
      input.dispatchEvent(event)
      return event.defaultPrevented
    })

    expect(defaultPrevented).toBe(true)
    expect((await activeTopology(orcaPage, tabId)).exists).toBe(true)
  })
})
