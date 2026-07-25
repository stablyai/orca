import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import {
  execInTerminal,
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

type PaneOscObserverWindow = Window & { __oscBackgroundQueriesSeen?: string[] }

// Why: both responders write the identical reply, so observing the reply cannot prove which one
// produced it. Record the queries the pane's parser sees instead: the startup transaction consumes
// what it answers, so a query reaching this handler proves it was released downstream.
async function recordPaneOscBackgroundQueries(page: Page): Promise<void> {
  await page.evaluate(() => {
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
      throw new Error('No active terminal pane to observe')
    }
    const observerWindow = window as PaneOscObserverWindow
    observerWindow.__oscBackgroundQueriesSeen = []
    pane.terminal.parser.registerOscHandler(11, (data: string) => {
      observerWindow.__oscBackgroundQueriesSeen?.push(data)
      // Why: false keeps the existing color-query responder in the chain.
      return false
    })
  })
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

// Why: bundled ConPTY forwards OSC 10/11 to Orca instead of answering it. A query the startup
// transaction cannot answer must still reach the pane responder, or the program falls back to the
// pseudoconsole palette (#0c0c0c) and paints a dark UI inside a light pane.
const STARTUP_INGRESS_DEADLINE_MS = 5_000

test('releases a color query a real PTY emits after the startup window closes', async ({
  electronApp,
  orcaPage
}) => {
  await installTerminalPtyWriteSpy(electronApp)
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await waitForActiveTerminalManager(orcaPage, 30_000)

  const ptyId = await waitForActivePanePtyId(orcaPage)
  await setActiveTerminalTheme(orcaPage, {
    foreground: '#2e3434',
    background: 'rgba(255, 255, 255, 1)'
  })
  await recordPaneOscBackgroundQueries(orcaPage)
  await clearTerminalPtyWriteLog(electronApp)

  // Why: the query must land after any startup transaction has expired, otherwise the source owner
  // could answer it and the assertions below would not describe the downstream responder.
  await orcaPage.waitForTimeout(STARTUP_INGRESS_DEADLINE_MS + 500)

  // Why: BEL terminates the query without a backslash, so the one command line survives both
  // PowerShell and POSIX shell quoting.
  await execInTerminal(orcaPage, ptyId, `node -e "process.stdout.write('\\x1b]11;?\\x07')"`)

  await expect
    .poll(
      async () =>
        orcaPage.evaluate(() => (window as PaneOscObserverWindow).__oscBackgroundQueriesSeen ?? []),
      {
        timeout: 20_000,
        message: 'the post-startup color query never reached the pane responder'
      }
    )
    .toContain('?')

  expect(
    (await readTerminalPtyWriteEntries(electronApp))
      .filter((entry) => entry.id === ptyId)
      .map((entry) => entry.data)
  ).toContain('\x1b]11;rgb:ffff/ffff/ffff\x1b\\')
})
