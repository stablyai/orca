import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { waitForRichMarkdownEditor } from './helpers/markdown-editor-fixture'

function readBrowser(page: Page, browserId: string) {
  return page.evaluate(async (id) => {
    const webview = document.querySelector<Electron.WebviewTag>(
      `[data-browser-overlay-tab-id="${id}"] webview`
    )
    if (!webview) {
      return null
    }
    try {
      const value: unknown = await webview.executeJavaScript(
        'document.getElementById("counter").textContent'
      )
      return { contentsId: webview.getWebContentsId(), value }
    } catch {
      return null
    }
  }, browserId)
}

test('keeps a browser guest and an unsaved editor draft through view changes', async ({
  orcaPage: page,
  registerPostElectronShutdownCleanup
}) => {
  // Cold editor and browser initialization precedes the retained guest and draft checks.
  test.setTimeout(180_000)
  await waitForSessionReady(page)
  const workspaceId = await waitForActiveWorktree(page)
  await ensureTerminalVisible(page)
  const note = await page.evaluate(async (worktreeId) => {
    const store = window.__store!
    const before = new Set(store.getState().openFiles.map((file) => file.id))
    await store
      .getState()
      .openNewMarkdownInActiveWorkspace(store.getState().activeGroupIdByWorktree[worktreeId] ?? '')
    const file = store.getState().openFiles.find((file) => !before.has(file.id) && file.isUntitled)
    if (!file) {
      throw new Error('No untitled note')
    }
    return { id: file.id, path: file.filePath }
  }, workspaceId)
  const draft = 'Draft retained while working across projects.'
  const editor = await waitForRichMarkdownEditor(page)
  await editor.click()
  await page.keyboard.insertText(draft)
  await expect(editor).toContainText(draft)
  expect(readFileSync(note.path, 'utf8')).not.toContain(draft)

  const directory = mkdtempSync(path.join(os.tmpdir(), 'orca-views-browser-'))
  registerPostElectronShutdownCleanup(async () =>
    rmSync(directory, { recursive: true, force: true })
  )
  const file = path.join(directory, 'preview.html')
  writeFileSync(
    file,
    '<!doctype html><html><head><title>View preview</title><style>html{color-scheme:light dark}body{font:16px system-ui;padding:24px;background:Canvas;color:CanvasText}button{padding:12px}</style></head><body><h1>Local preview</h1><button id="counter" onclick="this.textContent=String(Number(this.textContent)+1)">0</button></body></html>'
  )
  const browserId = await page.evaluate(
    ({ worktreeId, url }) =>
      window
        .__store!.getState()
        .createBrowserTab(worktreeId, url, { title: 'Preview', activate: true })?.id,
    { worktreeId: workspaceId, url: pathToFileURL(file).href }
  )
  if (!browserId) {
    throw new Error('No browser tab')
  }
  await expect.poll(() => readBrowser(page, browserId)).toMatchObject({ value: '0' })
  await page.evaluate(async (id) => {
    const webview = document.querySelector<Electron.WebviewTag>(
      `[data-browser-overlay-tab-id="${id}"] webview`
    )
    if (!webview) {
      throw new Error('No browser guest')
    }
    await webview.executeJavaScript('document.getElementById("counter").click()')
  }, browserId)
  const before = await readBrowser(page, browserId)
  expect(before?.value).toBe('1')

  await page.evaluate(
    ({ workspaceId, noteId, browserId }) => {
      const state = window.__store!.getState()
      const tabs = state.unifiedTabsByWorktree[workspaceId]
      const selected = [
        tabs.find((tab) => tab.entityId === noteId),
        tabs.find((tab) => tab.contentType === 'browser' && tab.entityId === browserId)
      ]
      if (selected.some((tab) => !tab)) {
        throw new Error('Selected panels are missing')
      }
      state.createWorkspaceView('Review')
      for (const tab of selected) {
        if (!tab) {
          throw new Error('Missing tab')
        }
        state.addWorkspaceViewPanel({
          workspaceId,
          executionHostId: 'local',
          tabId: tab.id,
          title: tab.customLabel || tab.label,
          workspaceName: 'main',
          projectName: 'View fixture'
        })
      }
    },
    { workspaceId, noteId: note.id, browserId }
  )
  await expect(page.locator('[data-workspace-view-panel-id]')).toHaveCount(2)
  const visibleEditor = page.locator('.rich-markdown-editor:visible')
  await expect(visibleEditor).toContainText(draft)
  await expect.poll(() => readBrowser(page, browserId)).toEqual(before)
  await visibleEditor.click()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.insertText(' More work in the view.')
  await expect(visibleEditor).toContainText('More work in the view.')
  await page.getByRole('radio', { name: 'Primary and stack' }).click()
  await page.getByRole('button', { name: 'Fill window', exact: true }).click()
  await expect
    .poll(() =>
      visibleEditor.evaluate((element) => {
        const body = element.closest('[data-workspace-view-body]')
        const editorPanel = body?.firstElementChild
        if (!body || !editorPanel) {
          return Infinity
        }
        return Math.abs(
          body.getBoundingClientRect().height - editorPanel.getBoundingClientRect().height
        )
      })
    )
    .toBeLessThan(2)
  for (const theme of ['light', 'dark'] as const) {
    await page.evaluate((theme) => window.__store!.getState().updateSettings({ theme }), theme)
    await expect
      .poll(() => page.evaluate(() => document.documentElement.classList.contains('dark')))
      .toBe(theme === 'dark')
    await expect(visibleEditor).toContainText(draft)
    await expect.poll(() => readBrowser(page, browserId)).toEqual(before)
    await page.screenshot({ path: test.info().outputPath(`mixed-panels-${theme}.png`) })
  }
  await page.getByRole('button', { name: 'Return to workspace', exact: true }).click()
  await page.evaluate((id) => window.__store!.getState().setActiveFile(id), note.id)
  await expect(page.locator('.rich-markdown-editor:visible')).toContainText(draft)
  await expect(page.locator('.rich-markdown-editor:visible')).toContainText(
    'More work in the view.'
  )
  expect(readFileSync(note.path, 'utf8')).not.toContain(draft)
  await page.evaluate((id) => {
    window.__store!.getState().markFileDirty(id, false)
    window.__store!.getState().closeFile(id)
  }, note.id)
})
