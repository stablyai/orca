import { randomUUID } from 'node:crypto'
import { rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import {
  ensureTerminalVisible,
  getActiveTabId,
  getActiveWorktreeId,
  getWorktreeTabs,
  waitForActiveWorktree,
  waitForSessionReady
} from './helpers/store'
import {
  focusActiveTerminalInput,
  sendToTerminal,
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForTerminalOutput
} from './helpers/terminal'
import {
  clearTerminalPtyWriteLog,
  installTerminalPtyWriteSpy,
  readTerminalPtyWrites
} from './helpers/terminal-pty-write-spy'

function pasteEchoScript(runId: string): string {
  return `
process.stdin.setEncoding('utf8')
if (process.stdin.isTTY) process.stdin.setRawMode(true)
process.stdin.resume()
let seq = 0
const interrupt = String.fromCharCode(3)
process.stdout.write('APP_MENU_PASTE_READY_${runId}\\n')
process.stdin.on('data', (chunk) => {
  if (chunk.includes(interrupt)) {
    process.exit(0)
  }
  seq += 1
  const encoded = Buffer.from(chunk, 'utf8').toString('base64')
  process.stdout.write('APP_MENU_PASTE_CHUNK_${runId}_' + seq + ':' + encoded + '\\n')
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

async function dispatchAppMenuPasteFromMain(app: ElectronApplication): Promise<void> {
  const sentCount = await app.evaluate(({ BrowserWindow }) => {
    // Headless Electron can have DOM focus without BrowserWindow focus; the
    // production menu sends this same IPC event to the focused app window.
    const windows = BrowserWindow.getAllWindows().filter((window) => !window.isDestroyed())
    for (const window of windows) {
      window.webContents.send('ui:appMenuPaste')
    }
    return windows.length
  })
  expect(sentCount).toBeGreaterThan(0)
}

async function getActiveTabTitle(page: Page, worktreeId: string): Promise<string> {
  const activeId = await getActiveTabId(page)
  expect(activeId).not.toBeNull()
  const tabs = await getWorktreeTabs(page, worktreeId)
  const tab = tabs.find((entry) => entry.id === activeId)
  expect(tab).toBeDefined()
  return tab!.customTitle ?? tab!.title ?? ''
}

function tabLocatorByTitle(page: Page, title: string): ReturnType<Page['locator']> {
  const escaped = title.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  return page.locator(`[data-testid="sortable-tab"][data-tab-title="${escaped}"]`).first()
}

test.describe('app menu paste ownership', () => {
  test.beforeEach(async ({ electronApp, orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)
    await installTerminalPtyWriteSpy(electronApp)
  })

  test('Edit > Paste sends clipboard text to the focused terminal exactly once', async ({
    electronApp,
    orcaPage,
    testRepoPath
  }) => {
    const ptyId = await waitForActivePanePtyId(orcaPage)
    const runId = randomUUID()
    const scriptPath = path.join(testRepoPath, `.orca-app-menu-paste-${runId}.mjs`)
    writeFileSync(scriptPath, pasteEchoScript(runId))
    let scriptStarted = false

    try {
      await sendToTerminal(orcaPage, ptyId, `node ${JSON.stringify(scriptPath)}\r`)
      scriptStarted = true
      await waitForTerminalOutput(orcaPage, `APP_MENU_PASTE_READY_${runId}`, 10_000)

      const payload = `ORCA_E2E_APP_MENU_TERMINAL_${runId}`
      const encodedPayload = Buffer.from(payload, 'utf8').toString('base64')
      await orcaPage.evaluate((text) => window.api.ui.writeClipboardText(text), payload)
      await clearTerminalPtyWriteLog(electronApp)
      await focusActiveTerminalInput(orcaPage)

      await dispatchAppMenuPasteFromMain(electronApp)
      await waitForTerminalOutput(orcaPage, encodedPayload, 10_000, 12_000)

      const writes = (await readTerminalPtyWrites(electronApp)).join('')
      expect(countOccurrences(writes, payload)).toBe(1)
    } finally {
      if (scriptStarted) {
        await sendToTerminal(orcaPage, ptyId, '\x03').catch(() => undefined)
      }
      rmSync(scriptPath, { force: true })
    }
  })

  test('Edit > Paste into a rename textbox does not also write to the active terminal', async ({
    electronApp,
    orcaPage
  }) => {
    const worktreeId = (await getActiveWorktreeId(orcaPage))!
    const originalTitle = await getActiveTabTitle(orcaPage, worktreeId)
    await tabLocatorByTitle(orcaPage, originalTitle).dblclick()

    const renameInput = orcaPage.getByRole('textbox', {
      name: `Rename tab ${originalTitle}`,
      exact: true
    })
    await expect(renameInput).toBeVisible()
    await renameInput.fill('')

    const payload = `ORCA_E2E_APP_MENU_TEXTBOX_${randomUUID()}`
    await orcaPage.evaluate((text) => window.api.ui.writeClipboardText(text), payload)
    await clearTerminalPtyWriteLog(electronApp)
    await expect(renameInput).toBeFocused()

    await dispatchAppMenuPasteFromMain(electronApp)

    await expect(renameInput).toHaveValue(payload)
    expect(countOccurrences(await renameInput.inputValue(), payload)).toBe(1)
    expect((await readTerminalPtyWrites(electronApp)).join('')).not.toContain(payload)

    await renameInput.press('Escape')
    await expect(tabLocatorByTitle(orcaPage, originalTitle)).toBeVisible()
  })
})
