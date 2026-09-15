import type { Page, TestInfo } from '@stablyai/playwright-test'
import { expect } from './orca-app'
import { buildOwnedEditorFileId } from '../../../src/renderer/src/store/slices/editor/file-ids/editor-file-ids'

export async function reloadSecondaryDraft(secondary: Page, filePath: string, testInfo: TestInfo) {
  const saved = await secondary.evaluate(async () => {
    const state = window.__store!.getState()
    await window.api.ui.set({ windowPaneLayout: state.windowPaneLayout })
    return state.windowPaneLayout
  })
  await testInfo.attach('editor-before-reload', {
    body: JSON.stringify(
      await secondary.evaluate(() => ({
        files: window.__store!.getState().openFiles,
        drafts: window.__store!.getState().editorDrafts,
        sessions: Object.fromEntries(
          Object.keys(localStorage)
            .filter((key) => key.includes('workspaceSession'))
            .map((key) => [key, JSON.parse(localStorage.getItem(key)!)])
        )
      }))
    ),
    contentType: 'application/json'
  })
  await Promise.all([
    secondary.waitForEvent('domcontentloaded'),
    secondary.evaluate(() => {
      void window.api.app.reload()
    })
  ])
  await secondary.waitForFunction(() => window.__store?.getState().workspaceSessionReady === true)
  await testInfo.attach('editor-after-reload', {
    body: JSON.stringify(
      await secondary.evaluate(() => ({
        files: window.__store!.getState().openFiles,
        drafts: window.__store!.getState().editorDrafts,
        sessions: Object.fromEntries(
          Object.keys(localStorage)
            .filter((key) => key.includes('workspaceSession'))
            .map((key) => [key, JSON.parse(localStorage.getItem(key)!)])
        )
      }))
    ),
    contentType: 'application/json'
  })
  await expect
    .poll(() => secondary.evaluate(() => window.__store!.getState().windowPaneLayout))
    .toEqual({
      ...saved,
      views: Object.fromEntries(
        Object.entries(saved!.views).map(([id, view]) => [
          id,
          view.contentType === 'editor'
            ? {
                ...view,
                entityId: buildOwnedEditorFileId(
                  filePath,
                  view.worktreeId,
                  view.executionHostId.slice('runtime:'.length)
                )
              }
            : view
        ])
      )
    })
  await expect(secondary.locator('.rich-markdown-editor:visible')).toContainText(
    'PANE4 UNSAVED SENTINEL'
  )
}
