import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from './helpers/orca-app'
import {
  ensureTerminalVisible,
  getActiveWorktreeId,
  waitForActiveWorktree,
  waitForSessionReady
} from './helpers/store'

const FIXTURE_NAME = 'orca-browser-preview.html'
const FIXTURE_MARKER = 'orca html browser preview'

test('opens an HTML editor file in Orca Browser from the visible header action', async ({
  orcaPage,
  testRepoPath
}) => {
  writeFileSync(
    path.join(testRepoPath, FIXTURE_NAME),
    `<!doctype html><html><body><h1 id="preview-marker">${FIXTURE_MARKER}</h1></body></html>\n`
  )
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  const worktreeId = await getActiveWorktreeId(orcaPage)
  expect(worktreeId).not.toBeNull()

  await orcaPage.evaluate(
    ({ filePath, targetWorktreeId }) => {
      window.__store?.getState().openFile({
        filePath,
        relativePath: 'orca-browser-preview.html',
        worktreeId: targetWorktreeId,
        language: 'html',
        mode: 'edit'
      })
    },
    { filePath: path.join(testRepoPath, FIXTURE_NAME), targetWorktreeId: worktreeId! }
  )

  const openInBrowser = orcaPage.getByTestId('open-html-in-orca-browser')
  await expect(openInBrowser).toBeVisible({ timeout: 20_000 })
  await openInBrowser.click()

  const resolveBrowserTabId = () =>
    orcaPage.evaluate(
      ({ fixtureName, targetWorktreeId }) =>
        window.__store
          ?.getState()
          .browserTabsByWorktree[targetWorktreeId]?.find((tab) =>
            tab.url.endsWith(`/${fixtureName}`)
          )?.id ?? null,
      { fixtureName: FIXTURE_NAME, targetWorktreeId: worktreeId! }
    )
  await expect.poll(resolveBrowserTabId, { timeout: 20_000 }).not.toBeNull()
  const browserTabId = await resolveBrowserTabId()
  expect(browserTabId).not.toBeNull()

  await expect
    .poll(
      () =>
        orcaPage.evaluate(async (targetBrowserTabId) => {
          const slot = document.querySelector(
            `[data-browser-overlay-tab-id="${targetBrowserTabId}"]`
          )
          const webview = slot?.querySelector('webview') as Electron.WebviewTag | null
          if (!webview) {
            return null
          }
          try {
            return await webview.executeJavaScript(
              'document.querySelector("#preview-marker")?.textContent ?? null'
            )
          } catch {
            return null
          }
        }, browserTabId!),
      { timeout: 20_000 }
    )
    .toBe(FIXTURE_MARKER)
})
