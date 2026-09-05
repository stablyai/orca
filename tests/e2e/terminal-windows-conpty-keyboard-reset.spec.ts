import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import {
  configureGoldenStubAgent,
  getGoldenStubAgentLaunchEnv,
  GOLDEN_STUB_EXIT_MARKER,
  launchGoldenStubAgentFromNewTab
} from './helpers/golden-stub-agent'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  focusActiveTerminalInput,
  waitForActivePanePtyId,
  waitForTerminalOutput
} from './helpers/terminal'
import {
  clearTerminalPtyWriteLog,
  installTerminalPtyWriteSpy,
  readTerminalPtyWriteEntries
} from './helpers/terminal-pty-write-spy'

test.use({ launchEnv: getGoldenStubAgentLaunchEnv() })
test.skip(process.platform !== 'win32', 'A real Windows ConPTY is required')

async function getKittyKeyboardFlags(page: Page): Promise<number | null> {
  return page.evaluate(() => {
    const state = window.__store?.getState()
    const worktreeId = state?.activeWorktreeId
    const tabId =
      state?.activeTabType === 'terminal'
        ? state.activeTabId
        : worktreeId
          ? (state?.activeTabIdByWorktree?.[worktreeId] ?? null)
          : null
    const pane = tabId ? window.__paneManagers?.get(tabId)?.getActivePane?.() : null
    const terminal = pane?.terminal as
      | {
          core?: { coreService?: { kittyKeyboard?: { flags?: number } } }
          _core?: { coreService?: { kittyKeyboard?: { flags?: number } } }
        }
      | undefined
    return (
      terminal?.core?.coreService?.kittyKeyboard?.flags ??
      terminal?._core?.coreService?.kittyKeyboard?.flags ??
      null
    )
  })
}

test('resets standard keyboard bytes after a protocol-mode agent exits on ConPTY', async ({
  electronApp,
  orcaPage
}) => {
  await installTerminalPtyWriteSpy(electronApp)
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await configureGoldenStubAgent(orcaPage, { agentArgs: '--keyboard-protocol' })
  await launchGoldenStubAgentFromNewTab(orcaPage)

  const ptyId = await waitForActivePanePtyId(orcaPage)
  await expect.poll(() => getKittyKeyboardFlags(orcaPage), { timeout: 10_000 }).toBe(1)

  await clearTerminalPtyWriteLog(electronApp)
  await orcaPage.keyboard.type('exit')
  await orcaPage.keyboard.press('Enter')
  await waitForTerminalOutput(orcaPage, GOLDEN_STUB_EXIT_MARKER, 15_000)
  const protocolWrites = (await readTerminalPtyWriteEntries(electronApp))
    .filter((entry) => entry.id === ptyId)
    .map((entry) => entry.data)
    .join('')
  expect(protocolWrites.includes('\x1b[13u') || protocolWrites.includes('\x1b[13;1u')).toBe(true)
  await expect.poll(() => getKittyKeyboardFlags(orcaPage), { timeout: 10_000 }).toBe(0)

  await clearTerminalPtyWriteLog(electronApp)
  await focusActiveTerminalInput(orcaPage)
  await orcaPage.keyboard.type("Write-Output ('CONPTY_KEYBOARD_' + '")
  await orcaPage.evaluate((text) => window.api.ui.writeClipboardText(text), 'REET_')
  await orcaPage.keyboard.press('Control+V')
  await orcaPage.keyboard.press('ArrowLeft')
  await orcaPage.keyboard.press('ArrowLeft')
  await orcaPage.keyboard.press('ArrowLeft')
  await orcaPage.keyboard.type('S')
  await orcaPage.keyboard.press('ArrowRight')
  await orcaPage.keyboard.press('ArrowRight')
  await orcaPage.keyboard.press('ArrowRight')
  await orcaPage.keyboard.type('EXECUTEX')
  await orcaPage.keyboard.press('Backspace')
  await orcaPage.keyboard.type("D')")
  await orcaPage.keyboard.press('Enter')
  await waitForTerminalOutput(orcaPage, 'CONPTY_KEYBOARD_RESET_EXECUTED', 15_000)

  const shellWrites = (await readTerminalPtyWriteEntries(electronApp))
    .filter((entry) => entry.id === ptyId)
    .map((entry) => entry.data)
  const joinedShellWrites = shellWrites.join('')
  expect(joinedShellWrites).toContain('REET_')
  expect(shellWrites.filter((data) => data === '\x1b[D')).toHaveLength(3)
  expect(shellWrites.filter((data) => data === '\x1b[C')).toHaveLength(3)
  expect(shellWrites).toContain('\x7f')
  expect(shellWrites).toContain('\r')
  expect(joinedShellWrites).not.toMatch(new RegExp(`${String.fromCharCode(27)}\\[\\d+(?:;\\d+)*u`))
})
