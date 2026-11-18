import { randomUUID } from 'node:crypto'
import 'node:child_process'
import { rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import type { WINDOWS_GIT_BASH_SHELL } from '../../../../src/shared/shell/launch/windows-terminal-shell'
import { test } from '../../desktop/electron-fixtures/orca-app'
import { expect } from '@stablyai/playwright-test'
import { focusActiveTerminalInput, waitForActivePanePtyId } from './terminal'
import {
  sendToTerminal,
  waitForActiveTerminalManager,
  waitForTerminalOutput
} from '../layout/terminal-pane-operations'
import {
  ensureTerminalVisible,
  waitForActiveWorktree,
  waitForSessionReady
} from '../../desktop/renderer-probes/store'
import {
  clearTerminalPtyWriteLog,
  installTerminalPtyWriteSpy,
  readTerminalPtyWrites
} from './terminal-pty-write-spy'

type WindowsPasteShell = 'cmd.exe' | 'powershell.exe' | 'wsl.exe' | typeof WINDOWS_GIT_BASH_SHELL

function pasteCollectScript(runId: string, sentinel: string, expectedText: string): string {
  return `
process.stdin.setEncoding('utf8')
if (process.stdin.isTTY) process.stdin.setRawMode(true)
process.stdin.resume()
let received = ''
const interrupt = String.fromCharCode(3)
const bracketStart = String.fromCharCode(27) + '[200~'
const bracketEnd = String.fromCharCode(27) + '[201~'
const expectedText = ${JSON.stringify(expectedText)}
process.stdout.write('PASTE_READY_${runId}\\n')
process.stdin.on('data', (chunk) => {
  if (chunk.includes(interrupt)) {
    process.exit(0)
  }
  received += chunk
  if (!received.includes(${JSON.stringify(sentinel)})) {
    return
  }
  const normalized = received.split(bracketStart).join('').split(bracketEnd).join('')
  const status = normalized === expectedText
    ? 'MATCH'
    : 'MISMATCH:' + normalized.length + ':' + expectedText.length
  process.stdout.write('PASTE_COMPLETE_${runId}:' + status + '\\n')
})
`
}

function countOccurrences(value: string, needle: string): number {
  let count = 0
  let index = value.indexOf(needle)
  while (index !== -1) {
    count += 1
    index = value.indexOf(needle, index + needle.length)
  }
  return count
}

async function createWindowsDefaultShellTerminalTab(
  page: Page,
  shell: WindowsPasteShell
): Promise<string> {
  const tabId = await page.evaluate(async (selectedShell) => {
    const store = window.__store
    if (!store) {
      throw new Error('Store unavailable')
    }
    const state = store.getState()
    const worktreeId = state.activeWorktreeId
    if (!worktreeId) {
      throw new Error('No active worktree')
    }

    await state.updateSettings({ terminalWindowsShell: selectedShell })
    const terminal = store.getState().createTab(worktreeId)
    store.getState().setActiveTab(terminal.id)
    store.getState().setActiveTabType('terminal', store.getState().activeWorktreeId)
    return terminal.id
  }, shell)

  const tab = page.locator(`[data-testid="sortable-tab"][data-tab-id="${tabId}"]`)
  await expect(tab).toBeVisible()
  await expect(tab.locator('[data-shell-icon]')).toHaveAttribute('data-shell-icon', shell)

  return tabId
}

test.describe('Windows terminal shell paste ownership', () => {
  test.skip(process.platform !== 'win32', 'Windows terminal shell paste coverage is Windows-only')

  test('PowerShell default terminal keyboard paste preserves exact content with one PTY owner', async ({
    electronApp,
    orcaPage,
    testRepoPath
  }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await createWindowsDefaultShellTerminalTab(orcaPage, 'powershell.exe')
    await waitForActiveTerminalManager(orcaPage, 30_000)
    await installTerminalPtyWriteSpy(electronApp)

    const ptyId = await waitForActivePanePtyId(orcaPage)
    const runId = randomUUID()
    const sentinel = `ORCA_E2E_POWERSHELL_DONE_${runId}`
    const powershellEscape = '`'
    const payload = [
      `ORCA_E2E_POWERSHELL_PASTE_${runId}`,
      `PowerShell metacharacters: ${powershellEscape} $ " ' ; | & < > @ { } ( )`,
      'quoted Windows path: C:\\Program Files\\Orca Test\\file name.txt',
      'cmd metacharacters preserved as text: %PATH% !PROMPT! ^ & | < >',
      'Unicode: café 你好 مرحبا 😀',
      `mixed-newline-before\r\nlf-line\ncrlf-line\r\n${sentinel}`
    ].join('\n')
    const scriptPath = path.join(testRepoPath, `.orca-paste-powershell-shell-${runId}.mjs`)
    const expectedText = payload.replace(/\r?\n/g, '\r')
    writeFileSync(scriptPath, pasteCollectScript(runId, sentinel, expectedText))
    let scriptStarted = false

    try {
      await sendToTerminal(orcaPage, ptyId, `node ${JSON.stringify(scriptPath)}\r`)
      scriptStarted = true
      await waitForTerminalOutput(orcaPage, `PASTE_READY_${runId}`, 10_000)

      await clearTerminalPtyWriteLog(electronApp)
      await orcaPage.evaluate((text) => window.api.ui.writeClipboardText(text), payload)
      await focusActiveTerminalInput(orcaPage)

      await orcaPage.keyboard.press('Control+V')
      await waitForTerminalOutput(orcaPage, `PASTE_COMPLETE_${runId}:MATCH`, 10_000, 12_000)

      const writes = (await readTerminalPtyWrites(electronApp)).join('')
      expect(countOccurrences(writes, expectedText), 'PowerShell payload PTY write count').toBe(1)
    } finally {
      if (scriptStarted) {
        await sendToTerminal(orcaPage, ptyId, '\x03').catch(() => undefined)
      }
      rmSync(scriptPath, { force: true })
    }
  })
})
