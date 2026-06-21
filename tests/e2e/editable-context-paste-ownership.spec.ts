import { randomUUID } from 'node:crypto'
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
import { waitForActiveTerminalManager } from './helpers/terminal'
import {
  clearTerminalPtyWriteLog,
  installTerminalPtyWriteSpy,
  readTerminalPtyWrites
} from './helpers/terminal-pty-write-spy'

async function dispatchEditableContextPasteFromMain(
  app: ElectronApplication,
  options: { plainTextOnly?: boolean } = {}
): Promise<void> {
  const sentCount = await app.evaluate(
    ({ BrowserWindow }, payload) => {
      const windows = BrowserWindow.getAllWindows().filter((window) => !window.isDestroyed())
      for (const window of windows) {
        window.webContents.send('ui:editableContextPaste', {
          plainTextOnly: payload.plainTextOnly === true
        })
      }
      return windows.length
    },
    { plainTextOnly: options.plainTextOnly === true }
  )
  expect(sentCount).toBeGreaterThan(0)
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

test.describe('editable context paste ownership', () => {
  test('context-menu paste into a rename textbox does not also write to the active terminal', async ({
    electronApp,
    orcaPage
  }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)
    await installTerminalPtyWriteSpy(electronApp)

    const worktreeId = (await getActiveWorktreeId(orcaPage))!
    const originalTitle = await getActiveTabTitle(orcaPage, worktreeId)
    await tabLocatorByTitle(orcaPage, originalTitle).dblclick()

    const renameInput = orcaPage.getByRole('textbox', {
      name: `Rename tab ${originalTitle}`,
      exact: true
    })
    await expect(renameInput).toBeVisible()
    await renameInput.fill('')

    const payload = `ORCA_E2E_CONTEXT_TEXTBOX_${randomUUID()}`
    await orcaPage.evaluate((text) => window.api.ui.writeClipboardText(text), payload)
    await clearTerminalPtyWriteLog(electronApp)
    await expect(renameInput).toBeFocused()

    await dispatchEditableContextPasteFromMain(electronApp)

    await expect(renameInput).toHaveValue(payload)
    expect(countOccurrences(await renameInput.inputValue(), payload)).toBe(1)
    expect((await readTerminalPtyWrites(electronApp)).join('')).not.toContain(payload)

    await renameInput.press('Escape')
    await expect(tabLocatorByTitle(orcaPage, originalTitle)).toBeVisible()
  })
})
