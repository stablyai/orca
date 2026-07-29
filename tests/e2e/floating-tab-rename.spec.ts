import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'

// Why: mirrors FLOATING_TERMINAL_WORKTREE_ID in src/shared/constants.ts.
// E2E specs avoid importing renderer/shared modules into the Playwright runner.
const FLOATING_WORKTREE_ID = 'global-floating-terminal'
const OPEN_PANEL_SELECTOR = '[data-floating-terminal-panel][aria-hidden="false"]'
const PANEL_SELECTOR = '[data-floating-terminal-panel]'

async function seedFloatingMarkdownFile(
  page: Page
): Promise<{ originalName: string; originalPath: string; renamedName: string; tabId: string }> {
  const directory = await page.evaluate(() => window.api.app.getFloatingMarkdownDirectory())
  const suffix = Date.now().toString(36)
  const originalName = `floating-rename-${suffix}.md`
  const renamedName = `floating-renamed-${suffix}.md`
  const originalPath = path.join(directory, originalName)
  const tabId = await page.evaluate(
    async ({ filePath, originalName, worktreeId }) => {
      const store = window.__store
      if (!store) {
        throw new Error('Store unavailable')
      }

      await store.getState().updateSettings({ floatingTerminalEnabled: true })
      await window.api.fs.createFile({ filePath })
      await window.api.fs.writeFile({ filePath, content: '# Floating rename\n' })
      store.getState().openFile(
        {
          filePath,
          relativePath: originalName,
          worktreeId,
          language: 'markdown',
          mode: 'edit',
          runtimeEnvironmentId: null
        },
        { preview: false, suppressActiveRuntimeFallback: true }
      )

      const state = store.getState()
      const file = state.openFiles.find(
        (candidate) => candidate.filePath === filePath && candidate.worktreeId === worktreeId
      )
      const tab = state.unifiedTabsByWorktree[worktreeId]?.find(
        (candidate) => candidate.contentType === 'editor' && candidate.entityId === file?.id
      )
      if (!file || !tab) {
        throw new Error('Floating Markdown tab unavailable')
      }
      return tab.id
    },
    { filePath: originalPath, originalName, worktreeId: FLOATING_WORKTREE_ID }
  )
  return { originalName, originalPath, renamedName, tabId }
}

async function openFloatingPanel(page: Page): Promise<void> {
  await page.waitForFunction(
    (selector) => Boolean(document.querySelector(selector)),
    PANEL_SELECTOR,
    { timeout: 30_000 }
  )
  await page.evaluate(() => window.dispatchEvent(new Event('orca-toggle-floating-terminal')))
  await expect(page.locator(OPEN_PANEL_SELECTOR)).toBeVisible()
}

test('floating workspace Markdown rename updates the tab and file on disk', async ({
  orcaPage
}) => {
  await waitForSessionReady(orcaPage)
  const seeded = await seedFloatingMarkdownFile(orcaPage)
  await openFloatingPanel(orcaPage)

  const panel = orcaPage.locator(OPEN_PANEL_SELECTOR)
  const tab = panel.locator(`[data-tab-id="${seeded.tabId}"]`)
  await expect(tab).toContainText(seeded.originalName)
  await tab.dispatchEvent('contextmenu', { button: 2, clientX: 120, clientY: 80 })
  const renameMenuItem = orcaPage.getByRole('menuitem').filter({ hasText: 'Rename' }).first()
  await expect(renameMenuItem).toBeVisible()
  await renameMenuItem.click()

  const renameInput = panel.getByRole('textbox', {
    name: `Rename file ${seeded.originalName}`,
    exact: true
  })
  await renameInput.fill(seeded.renamedName)
  await renameInput.press('Enter')

  await expect(tab).toContainText(seeded.renamedName)
  await expect
    .poll(() =>
      orcaPage.evaluate(
        async ({ renamedName, worktreeId }) => {
          const file = window.__store
            ?.getState()
            .openFiles.find(
              (candidate) =>
                candidate.worktreeId === worktreeId && candidate.filePath.endsWith(renamedName)
            )
          if (!file) {
            return null
          }
          return (await window.api.fs.readFile({ filePath: file.filePath })).content
        },
        { renamedName: seeded.renamedName, worktreeId: FLOATING_WORKTREE_ID }
      )
    )
    .toContain('# Floating rename')
  await expect
    .poll(() =>
      orcaPage.evaluate((filePath) => window.api.fs.pathExists({ filePath }), seeded.originalPath)
    )
    .toBe(false)
})
