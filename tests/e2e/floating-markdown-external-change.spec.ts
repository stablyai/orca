import { readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'

const FLOATING_OWNER = 'global-floating-terminal'
const PANEL = '[data-floating-terminal-panel][aria-hidden="false"]'

test.use({ seedTestRepo: false })

async function openNote(page: Page) {
  const directory = await page.evaluate(() => window.api.app.getFloatingMarkdownDirectory())
  const filePath = path.join(directory, 'external-note.md')
  await writeFile(filePath, '# Before external change\n')
  const tabId = await page.evaluate(
    async ({ filePath, worktreeId }) => {
      const store = window.__store
      if (!store) {
        throw new Error('Store unavailable')
      }
      await store
        .getState()
        .updateSettings({ floatingTerminalEnabled: true, editorAutoSave: false, uiLanguage: 'en' })
      store.getState().openFile(
        {
          filePath,
          relativePath: 'external-note.md',
          worktreeId,
          language: 'markdown',
          mode: 'edit',
          runtimeEnvironmentId: null
        },
        { preview: false, suppressActiveRuntimeFallback: true }
      )
      const state = store.getState()
      const file = state.openFiles.find((entry) => entry.filePath === filePath)
      const tab = state.unifiedTabsByWorktree[worktreeId]?.find(
        (entry) => entry.entityId === file?.id
      )
      if (!tab) {
        throw new Error('Floating tab unavailable')
      }
      return tab.id
    },
    { filePath, worktreeId: FLOATING_OWNER }
  )
  await page.waitForSelector('[data-floating-terminal-panel]', { state: 'attached' })
  if ((await page.locator(PANEL).count()) === 0) {
    await page.evaluate(() => window.dispatchEvent(new Event('orca-toggle-floating-terminal')))
  }
  const panel = page.locator(PANEL)
  const editor = panel.locator('.rich-markdown-editor[contenteditable="true"]')
  await expect(panel).toBeVisible()
  await expect(editor).toContainText('Before external change')
  return { filePath, panel, editor, tabId }
}

test('floating Markdown reloads real external writes after hide and rename without a project', async ({
  orcaPage
}, testInfo) => {
  const { filePath, panel, editor, tabId } = await openNote(orcaPage)
  await testInfo.attach('before', {
    body: await orcaPage.screenshot({ path: testInfo.outputPath('evidence.png') }),
    contentType: 'image/png'
  })
  await writeFile(filePath, '# External update\n')
  await expect(editor).toContainText('External update')

  const replacement = `${filePath}.tmp`
  await writeFile(replacement, '# Atomic replacement\n')
  await rename(replacement, filePath)
  await expect(editor).toContainText('Atomic replacement')
  await expect(panel.getByRole('alert')).toHaveCount(0)

  await orcaPage.evaluate(() => window.dispatchEvent(new Event('orca-toggle-floating-terminal')))
  await expect(panel).toHaveCount(0)
  for (let version = 0; version < 3; version++) {
    await writeFile(filePath, `# Hidden version ${version}\n`)
  }
  await orcaPage.evaluate(() => window.dispatchEvent(new Event('orca-toggle-floating-terminal')))
  await expect(editor).toContainText('Hidden version 2')

  const tab = panel.locator(`[data-tab-id="${tabId}"]`)
  await tab.getByText('external-note.md', { exact: true }).dispatchEvent('dblclick')
  const input = panel.getByRole('textbox', { name: 'Rename file external-note.md', exact: true })
  await input.fill('renamed-note.md')
  await input.press('Enter')
  await expect(tab).toContainText('renamed-note.md')
  const renamedPath = path.join(path.dirname(filePath), 'renamed-note.md')
  await writeFile(renamedPath, '# Updated after rename\n')
  await expect(editor).toContainText('Updated after rename')
  await testInfo.attach('after', {
    body: await orcaPage.screenshot({ path: testInfo.outputPath('after.png') }),
    contentType: 'image/png'
  })
})

test.describe('with a project mounting the autosave controller', () => {
  test.use({ seedTestRepo: true })

  test('floating conflicts preserve the draft and disk across autosave, then resume after a choice', async ({
    orcaPage
  }, testInfo) => {
    const { filePath, panel, editor } = await openNote(orcaPage)
    await editor.fill('My unsaved draft')
    await expect(editor).toContainText('My unsaved draft')
    // Why: rich-editor serialization is debounced; wait for the draft before triggering the disk race.
    await orcaPage.waitForFunction((filePath) => {
      const state = window.__store?.getState()
      const file = state?.openFiles.find((entry) => entry.filePath === filePath)
      return file?.isDirty && state?.editorDrafts[file.id]?.includes('My unsaved draft')
    }, filePath)
    await orcaPage.evaluate(async () => {
      await window.__store
        ?.getState()
        .updateSettings({ editorAutoSave: true, editorAutoSaveDelayMs: 1000 })
    })
    await writeFile(filePath, '# Agent update\n')
    const banner = panel.getByRole('alert')
    await expect(banner).toContainText('changed on disk')
    await expect(editor).toContainText('My unsaved draft')
    // Why: let two autosave deadlines pass; an immediate read cannot prove that autosave is suspended.
    await orcaPage.waitForTimeout(2200)
    expect(await readFile(filePath, 'utf8')).toBe('# Agent update\n')
    await expect(editor).toContainText('My unsaved draft')
    await testInfo.attach('conflict', {
      body: await orcaPage.screenshot({ path: testInfo.outputPath('conflict.png') }),
      contentType: 'image/png'
    })

    await banner.getByRole('button', { name: 'Keep My Edits', exact: true }).click()
    await expect.poll(() => readFile(filePath, 'utf8')).toContain('My unsaved draft')
    await expect(banner).toHaveCount(0)
    await writeFile(filePath, '# External write after own save\n')
    await expect(editor).toContainText('External write after own save')
    await expect(banner).toHaveCount(0)

    await orcaPage.evaluate(async () => {
      await window.__store?.getState().updateSettings({ editorAutoSave: false })
    })
    await editor.fill('Another draft')
    await orcaPage.waitForFunction((filePath) => {
      const state = window.__store?.getState()
      const file = state?.openFiles.find((entry) => entry.filePath === filePath)
      return file?.isDirty && state?.editorDrafts[file.id]?.includes('Another draft')
    }, filePath)
    await writeFile(filePath, '# Chosen disk content\n')
    await expect(banner).toContainText('changed on disk')
    await banner.getByRole('button', { name: 'Reload from Disk', exact: true }).click()
    await expect(editor).toContainText('Chosen disk content')
    await expect(banner).toHaveCount(0)
  })
})
