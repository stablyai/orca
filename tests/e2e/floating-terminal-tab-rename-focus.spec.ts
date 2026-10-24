import { mkdirSync } from 'node:fs'
import path from 'node:path'
import type { Locator, Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  resolveActiveTabId,
  splitActiveTerminalPane,
  waitForActiveTerminalManager,
  waitForPaneIdentitySnapshot
} from './helpers/terminal'

const FLOATING_WORKTREE_ID = 'global-floating-terminal'
const OPEN_PANEL_SELECTOR = '[data-floating-terminal-panel][aria-hidden="false"]'
const nextTabChord = process.platform === 'darwin' ? 'Meta+Shift+]' : 'Control+Shift+]'

async function openFloatingTerminals(page: Page): Promise<{ first: Locator; second: Locator }> {
  await waitForSessionReady(page)
  await waitForActiveWorktree(page)
  const ids = await page.evaluate(async (worktreeId) => {
    const store = window.__store!
    await store.getState().updateSettings({ floatingTerminalEnabled: true })
    const first = store.getState().createTab(worktreeId, undefined, undefined, { activate: false })
    const second = store.getState().createTab(worktreeId, undefined, undefined, { activate: false })
    store.getState().setTabCustomTitle(first.id, 'Rename target')
    store.getState().setTabCustomTitle(second.id, 'Other terminal')
    store.setState({ floatingWorkspacePanelOpen: true })
    return [first.id, second.id]
  }, FLOATING_WORKTREE_ID)
  const panel = page.locator(OPEN_PANEL_SELECTOR)
  await expect(panel).toBeVisible()
  const first = panel.locator(`[data-testid="sortable-tab"][data-tab-id="${ids[0]}"]`)
  const second = panel.locator(`[data-testid="sortable-tab"][data-tab-id="${ids[1]}"]`)
  await first.click()
  await expect(first).toHaveAttribute('data-active', 'true')
  await expect(
    panel.locator(`[data-terminal-tab-id="${ids[0]}"] .xterm-helper-textarea`)
  ).toBeFocused()
  return { first, second }
}

async function beginRename(
  page: Page,
  tab: Locator,
  entry: 'menu' | 'double-click'
): Promise<Locator> {
  if (entry === 'menu') {
    await tab.click({ button: 'right' })
    await page.getByRole('menuitem', { name: /^Change Title(?:\s|$)/ }).click()
    await expect(page.getByRole('menu')).toHaveCount(0)
  } else {
    await tab.dblclick()
  }
  const input = tab.locator('[data-tab-rename-input="true"]')
  await expect(input).toBeFocused()
  // Let activation's deferred focus finish while the rename input still owns focus.
  await settleDeferredFocus(page)
  return input
}

async function settleDeferredFocus(page: Page): Promise<void> {
  await page.evaluate(async () => {
    for (let frame = 0; frame < 6; frame += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    }
  })
}

async function expectKeyboardOutput(page: Page, tab: Locator, marker: string): Promise<void> {
  const tabId = await tab.getAttribute('data-tab-id')
  await expect(
    page.locator(`[data-terminal-tab-id="${tabId}"] .xterm-helper-textarea:focus`)
  ).toHaveCount(1)
  await expect
    .poll(() =>
      page.evaluate((id) => {
        const pane = id ? window.__paneManagers?.get(id)?.getActivePane() : null
        return Boolean(pane?.container.dataset.ptyId && pane.serializeAddon?.serialize().trim())
      }, tabId)
    )
    .toBe(true)
  await settleDeferredFocus(page)
  await expect(
    page.locator(`[data-terminal-tab-id="${tabId}"] .xterm-helper-textarea:focus`)
  ).toHaveCount(1)
  await page.keyboard.type(`echo ${marker}`)
  await page.keyboard.press('Enter')
  await expect
    .poll(() =>
      page.evaluate((id) => {
        const buffer = id
          ? window.__paneManagers?.get(id)?.getActivePane()?.terminal.buffer.active
          : null
        if (!buffer) {
          return []
        }
        return Array.from({ length: buffer.length }, (_, index) =>
          buffer.getLine(index)?.translateToString(true).trim()
        )
      }, tabId)
    )
    .toContain(marker)
}

for (const entry of ['menu', 'double-click'] as const) {
  for (const exit of ['Enter', 'Escape', 'empty'] as const) {
    test(`${entry} rename ${exit} returns floating keyboard input to the terminal`, async ({
      orcaPage
    }) => {
      const { first, second } = await openFloatingTerminals(orcaPage)
      await expectKeyboardOutput(orcaPage, first, 'ORCA_RENAME_BASELINE')
      await orcaPage.keyboard.press(nextTabChord)
      await expect(second).toHaveAttribute('data-active', 'true')
      await first.click()

      const input = await beginRename(orcaPage, first, entry)
      await input.fill('')
      if (exit !== 'empty') {
        await input.pressSequentially('Renamed terminal', { delay: 60 })
      }
      await orcaPage.keyboard.press(exit === 'Escape' ? 'Escape' : 'Enter')
      await expect(input).toHaveCount(0)
      await (exit === 'empty'
        ? expect(first).not.toHaveAttribute('data-tab-title', 'Rename target')
        : expect(first).toHaveAttribute(
            'data-tab-title',
            exit === 'Escape' ? 'Rename target' : 'Renamed terminal'
          ))
      await expect(
        orcaPage.locator(`${OPEN_PANEL_SELECTOR} .xterm-helper-textarea:focus`)
      ).toHaveCount(1)
      await expectKeyboardOutput(orcaPage, first, 'ORCA_RENAME_RECOVERED')
      await orcaPage.keyboard.press(nextTabChord)
      await expect(second).toHaveAttribute('data-active', 'true')
      await expectKeyboardOutput(orcaPage, second, 'ORCA_RENAME_SWITCHED')
    })
  }
}

test('blur commits without taking keyboard input back from another floating tab', async ({
  orcaPage
}) => {
  const { first, second } = await openFloatingTerminals(orcaPage)
  const input = await beginRename(orcaPage, first, 'double-click')
  await input.fill('Blur committed')
  await second.click()
  await expect(input).toHaveCount(0)
  await expect(first).toHaveAttribute('data-tab-title', 'Blur committed')
  await expect(second).toHaveAttribute('data-active', 'true')
  await expectKeyboardOutput(orcaPage, second, 'ORCA_RENAME_BLUR')
})

test('renaming an inactive floating tab does not activate or focus its terminal', async ({
  orcaPage
}) => {
  const { first, second } = await openFloatingTerminals(orcaPage)
  const input = await beginRename(orcaPage, second, 'menu')
  await expect(first).toHaveAttribute('data-active', 'true')
  await input.fill('Inactive renamed')
  await orcaPage.keyboard.press('Enter')
  await expect(second).toHaveAttribute('data-tab-title', 'Inactive renamed')
  await settleDeferredFocus(orcaPage)
  await expect(first).toHaveAttribute('data-active', 'true')
  const secondId = await second.getAttribute('data-tab-id')
  await expect(
    orcaPage.locator(`[data-terminal-tab-id="${secondId}"] .xterm-helper-textarea:focus`)
  ).toHaveCount(0)
})

test('blur preserves focus in the worktree search dialog', async ({ orcaPage }) => {
  const { first } = await openFloatingTerminals(orcaPage)
  const input = await beginRename(orcaPage, first, 'double-click')
  await input.fill('Search committed')
  await orcaPage
    .getByRole('button', { name: 'Search worktrees and browser tabs', exact: true })
    .click()
  await expect(input).toHaveCount(0)
  await expect(first).toHaveAttribute('data-tab-title', 'Search committed')
  const search = orcaPage.getByRole('dialog').locator('input').first()
  await expect(search).toBeFocused()
  await settleDeferredFocus(orcaPage)
  await orcaPage.keyboard.type('search owns input')
  await expect(search).toHaveValue('search owns input')
})

for (const change of ['hide', 'close'] as const) {
  test(`a ${change} at rename completion cancels the deferred floating focus return`, async ({
    orcaPage
  }) => {
    const { first } = await openFloatingTerminals(orcaPage)
    const tabId = await first.getAttribute('data-tab-id')
    const input = await beginRename(orcaPage, first, 'menu')
    await input.fill('Exiting tab')
    await orcaPage.evaluate(
      ({ tabId, change }) => {
        // Run after React handles Enter, but before any queued animation frame.
        document.addEventListener(
          'keydown',
          () => {
            const store = window.__store!
            if (change === 'hide') {
              store.setState({ floatingWorkspacePanelOpen: false })
            } else if (tabId) {
              store.getState().closeTab(tabId)
            }
          },
          { once: true }
        )
      },
      { tabId, change }
    )
    await orcaPage.keyboard.press('Enter')
    await expect(input).toBeHidden()
    await settleDeferredFocus(orcaPage)
    await expect(
      orcaPage.locator(`[data-terminal-tab-id="${tabId}"] .xterm-helper-textarea:focus`)
    ).toHaveCount(0)
  })
}

for (const workspace of ['git', 'folder'] as const) {
  test(`keyboard rename in a ${workspace} workspace returns input to the selected split leaf`, async ({
    orcaPage,
    electronApp
  }, testInfo) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    if (workspace === 'folder') {
      const folderPath = path.join(
        await electronApp.evaluate(({ app }) => app.getPath('home')),
        'rename-folder'
      )
      mkdirSync(folderPath)
      await orcaPage.evaluate(async (folderPath) => {
        const state = window.__store!.getState()
        await state.updateSettingsOrThrow({ defaultTuiAgent: 'blank' })
        const group = await window.api.projectGroups.create({
          name: 'Rename regression',
          parentPath: folderPath,
          createdFrom: 'folder-scan'
        })
        await state.fetchProjectGroups({ runtimeEnvironmentId: null, throwOnError: true })
        await state.createFolderWorkspace(
          { projectGroupId: group.id, name: 'Rename folder', folderPath },
          { runtimeEnvironmentId: null }
        )
        state.openModal('worktree-palette')
      }, folderPath)
      const palette = orcaPage.getByRole('dialog', { name: 'Jump to...' })
      await palette.getByRole('combobox').fill('Rename folder')
      await palette.getByRole('combobox').press('Enter')
      await expect(palette).toHaveCount(0)
    }
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage)
    await splitActiveTerminalPane(orcaPage, 'horizontal')
    await waitForPaneIdentitySnapshot(orcaPage, 2)
    const tabId = await resolveActiveTabId(orcaPage)
    const tab = orcaPage.locator(`[data-testid="sortable-tab"][data-tab-id="${tabId}"]`)
    const panes = orcaPage.locator(`[data-terminal-tab-id="${tabId}"] .pane[data-leaf-id]`)
    await panes.first().locator('.xterm-screen').click()
    await panes.last().locator('.xterm-screen').click()
    const leafId = await panes.last().getAttribute('data-leaf-id')
    expect(leafId).toBeTruthy()
    await expect
      .poll(() =>
        orcaPage.evaluate(
          (id) => (id ? window.__store?.getState().terminalLayoutsByTabId[id]?.activeLeafId : null),
          tabId
        )
      )
      .toBe(leafId)
    const input = await beginRename(orcaPage, tab, 'menu')
    await input.fill('Split renamed')
    await orcaPage.keyboard.press('Enter')
    await expect(input).toHaveCount(0)
    await expect(
      orcaPage.locator(`[data-leaf-id="${leafId}"] .xterm-helper-textarea`)
    ).toBeFocused()
    await expectKeyboardOutput(orcaPage, tab, 'ORCA_RENAME_SPLIT')
    await orcaPage.screenshot({ path: testInfo.outputPath('split-rename-focus.png') })
    expect(
      await electronApp.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().every((window) => !window.isVisible())
      )
    ).toBe(true)
  })
}
