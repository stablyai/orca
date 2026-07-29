import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import {
  waitForActivePaneHookDescriptor,
  waitForActivePanePtyId,
  waitForActiveTerminalManager
} from './helpers/terminal'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { waitForTerminalPtyDataInjector } from './helpers/terminal-pty-injection'
import {
  clearTerminalPtyWriteLog,
  installTerminalPtyWriteSpy,
  readTerminalPtyWriteEntries
} from './helpers/terminal-pty-write-spy'

type TerminalTheme = {
  foreground: string
  background: string
}

type TerminalPtyDataInjectionWindow = Window & {
  __terminalPtyDataInjection?: {
    inject: (paneKey: string, data: string) => boolean
  }
}

async function setActiveTerminalTheme(page: Page, theme: TerminalTheme): Promise<void> {
  await page.evaluate((nextTheme) => {
    const state = window.__store?.getState()
    const worktreeId = state?.activeWorktreeId
    const tabId =
      state?.activeTabType === 'terminal'
        ? state.activeTabId
        : worktreeId
          ? (state?.activeTabIdByWorktree?.[worktreeId] ?? null)
          : null
    const manager = tabId ? window.__paneManagers?.get(tabId) : null
    const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
    if (!pane) {
      throw new Error('No active terminal pane to theme')
    }
    pane.terminal.options.theme = nextTheme
  }, theme)
}

async function injectPtyOutput(page: Page, paneKey: string, data: string): Promise<boolean> {
  return page.evaluate(
    ({ targetPaneKey, output }) =>
      (window as TerminalPtyDataInjectionWindow).__terminalPtyDataInjection?.inject(
        targetPaneKey,
        output
      ) ?? false,
    { targetPaneKey: paneKey, output: data }
  )
}

test('answers OSC foreground and background color queries from the active terminal theme', async ({
  electronApp,
  orcaPage
}) => {
  await installTerminalPtyWriteSpy(electronApp)
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await waitForActiveTerminalManager(orcaPage, 30_000)

  const ptyId = await waitForActivePanePtyId(orcaPage)
  const { paneKey } = await waitForActivePaneHookDescriptor(orcaPage)
  await waitForTerminalPtyDataInjector(orcaPage, paneKey)
  await setActiveTerminalTheme(orcaPage, {
    foreground: '#2e3434',
    background: 'rgba(255, 255, 255, 1)'
  })
  await clearTerminalPtyWriteLog(electronApp)

  const injected = await injectPtyOutput(orcaPage, paneKey, '\x1b]10;?\x1b\\\x1b]11;?\x1b\\')

  expect(injected).toBe(true)
  await expect
    .poll(
      async () =>
        (await readTerminalPtyWriteEntries(electronApp))
          .filter((entry) => entry.id === ptyId)
          .map((entry) => entry.data),
      {
        timeout: 5_000,
        message: 'OSC color query replies were not written to the active PTY'
      }
    )
    .toEqual(['\x1b]10;rgb:2e2e/3434/3434\x1b\\', '\x1b]11;rgb:ffff/ffff/ffff\x1b\\'])
})
