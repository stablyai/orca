/**
 * E2E smoke test for the Canvas page: markdown and HTML files pinned as cards
 * render in place (MarkdownPreview / doc-preview webview), with screenshots for review.
 */

import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import { waitForSessionReady, waitForActiveWorktree, getActiveWorktreeId } from './helpers/store'

const MD_FILE_NAME = 'canvas-demo.md'
const HTML_FILE_NAME = 'canvas-demo.html'
const MD_BODY_TEXT = 'Markdown card rendering works.'

test.describe('Canvas page', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
  })

  test('mounts markdown and html files as canvas cards', async ({
    orcaPage,
    seededRepoPath
  }, testInfo) => {
    const mdPath = path.join(seededRepoPath, MD_FILE_NAME)
    const htmlPath = path.join(seededRepoPath, HTML_FILE_NAME)
    writeFileSync(mdPath, `# Canvas Demo\n\n${MD_BODY_TEXT}\n`)
    writeFileSync(
      htmlPath,
      '<!doctype html><html><body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:#0ea5e9;color:#fff;font-family:sans-serif"><h1>HTML prototype card</h1></body></html>'
    )

    const worktreeId = await getActiveWorktreeId(orcaPage)
    await orcaPage.evaluate(
      ({ targetWorktreeId, md, html }) => {
        const store = window.__store
        if (!store) {
          throw new Error('window.__store is not available')
        }
        const state = store.getState()
        state.openCanvasPage()
        state.addCanvasCard(targetWorktreeId, {
          filePath: md,
          x: 40,
          y: 40,
          width: 520,
          height: 420
        })
        state.addCanvasCard(targetWorktreeId, {
          filePath: html,
          x: 620,
          y: 40,
          width: 520,
          height: 420
        })
      },
      { targetWorktreeId: worktreeId, md: mdPath, html: htmlPath }
    )

    // Both cards mount as flow nodes with their file names in the header.
    const cardNodes = orcaPage.locator('.react-flow__node')
    await expect(cardNodes).toHaveCount(2)
    await expect(cardNodes.getByText(MD_FILE_NAME)).toBeVisible()
    await expect(cardNodes.getByText(HTML_FILE_NAME)).toBeVisible()

    // The markdown card renders the document body; the html card attaches a preview frame
    // (doc-preview webview when a grant is available, sandboxed srcdoc iframe otherwise).
    await expect(orcaPage.getByText(MD_BODY_TEXT)).toBeVisible()
    await expect(
      orcaPage.locator('.react-flow__node webview, .react-flow__node iframe')
    ).toHaveCount(1)
    await expect(orcaPage.getByText('Preview unavailable')).toHaveCount(0)

    await orcaPage.screenshot({ path: testInfo.outputPath('canvas-cards.png') })

    // Zooming via the controls keeps both cards on the canvas.
    await orcaPage.locator('.react-flow__controls-zoomin').click()
    await orcaPage.locator('.react-flow__controls-zoomin').click()
    await expect(orcaPage.locator('.react-flow__node')).toHaveCount(2)
    await orcaPage.screenshot({ path: testInfo.outputPath('canvas-zoomed.png') })
  })
})
