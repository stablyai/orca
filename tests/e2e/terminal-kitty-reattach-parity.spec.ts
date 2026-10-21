/**
 * A live app's kitty keyboard flags survive park and reveal in both records:
 * xterm (which encodes keys) and the pane mirror (which Orca's shortcut policy
 * reads). The reveal builds a fresh xterm, so without the replay epilogue's
 * restore xterm would sit at 0 while the mirror adopted the host's flags.
 */
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { parkHiddenTabBehindDecoy } from './helpers/terminal-hidden-parking'
import {
  ensureTerminalVisible,
  getActiveTabId,
  waitForActiveWorktree,
  waitForSessionReady
} from './helpers/store'
import {
  focusActiveTerminalInput,
  sendToTerminal,
  waitForActivePanePtyId,
  waitForActiveTerminalManager
} from './helpers/terminal'
import {
  clearTerminalPtyWriteLog,
  installTerminalPtyWriteSpy,
  readTerminalPtyWrites
} from './helpers/terminal-pty-write-spy'
import { waitForPtyShellEcho } from './terminal-pty-readiness'

const PARKING_DELAY_MS = Number(process.env.ORCA_E2E_TERMINAL_PARKING_DELAY_MS) || 500
const APP_FLAGS = 5

test.use({
  orcaAppExtraEnv: { ORCA_E2E_TERMINAL_PARKING_DELAY_MS: String(PARKING_DELAY_MS) }
})

async function readXtermKittyFlags(page: Page): Promise<number | null> {
  return page.evaluate(() => {
    const state = window.__store?.getState()
    const tabId = state?.activeTabId ?? null
    const manager = tabId ? window.__paneManagers?.get(tabId) : null
    const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: xterm exposes kitty flags only on its private core; null when absent.
    const terminal = pane?.terminal as
      | { _core?: { coreService?: { kittyKeyboard?: { flags?: number } } } }
      | undefined
    return terminal?._core?.coreService?.kittyKeyboard?.flags ?? null
  })
}

// Why Shift+Enter: the policy emits CSI-u only when the pane mirror reports kitty flags.
async function expectShiftEnterWrite(
  page: Page,
  app: ElectronApplication,
  expected: string
): Promise<void> {
  await clearTerminalPtyWriteLog(app)
  await focusActiveTerminalInput(page)
  await page.keyboard.press('Shift+Enter')
  await expect
    .poll(async () => (await readTerminalPtyWrites(app)).includes(expected), {
      timeout: 5_000,
      message: `Shift+Enter did not write ${JSON.stringify(expected)}`
    })
    .toBe(true)
}

async function activateTerminalTab(page: Page, tabId: string): Promise<void> {
  await page.evaluate((tabId) => {
    const state = window.__store?.getState()
    if (!state) {
      throw new Error('Orca store unavailable')
    }
    state.setActiveTabType('terminal', window.__store?.getState().activeWorktreeId ?? null)
    state.setActiveTab(tabId)
  }, tabId)
  await expect.poll(() => getActiveTabId(page)).toBe(tabId)
  await waitForActiveTerminalManager(page, 30_000)
}

test("park and reveal keep a live app's kitty flags in xterm and the mirror", async ({
  orcaPage,
  electronApp
}) => {
  test.skip(process.platform === 'win32', 'ConPTY panes withhold the kitty protocol')
  await installTerminalPtyWriteSpy(electronApp)
  await waitForSessionReady(orcaPage)
  const worktreeId = await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await waitForActiveTerminalManager(orcaPage, 30_000)
  const tabId = await getActiveTabId(orcaPage)
  if (!tabId) {
    throw new Error('no active terminal tab')
  }
  const ptyId = await waitForActivePanePtyId(orcaPage)
  await waitForPtyShellEcho(orcaPage, ptyId, 15_000)

  try {
    // The app stays alive through the park, so nothing grounds its flags.
    await sendToTerminal(orcaPage, ptyId, `printf '\\033[=${APP_FLAGS}u'; sleep 120\r`)
    await expect.poll(() => readXtermKittyFlags(orcaPage)).toBe(APP_FLAGS)
    await expectShiftEnterWrite(orcaPage, electronApp, '\x1b[13;2u')

    await parkHiddenTabBehindDecoy(orcaPage, worktreeId, tabId, {
      parkDelayMs: PARKING_DELAY_MS
    })
    await activateTerminalTab(orcaPage, tabId)
    await waitForActivePanePtyId(orcaPage)

    await expect
      .poll(() => readXtermKittyFlags(orcaPage), {
        timeout: 10_000,
        message: 'the revealed xterm did not get the live app kitty flags back'
      })
      .toBe(APP_FLAGS)
    await expectShiftEnterWrite(orcaPage, electronApp, '\x1b[13;2u')
  } finally {
    await sendToTerminal(orcaPage, ptyId, '\x03').catch(() => undefined)
  }
})
