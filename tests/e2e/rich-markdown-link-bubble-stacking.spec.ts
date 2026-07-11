/**
 * Reliability contract:
 * - Invariant: link actions remain visible and interactive when they cross the Explorer seam.
 * - Failure source: the in-editor bubble was clipped by overflow-hidden workbench ancestors.
 * - Oracle: a real Chromium hit test inside the bubble/Explorer overlap resolves to the bubble.
 * - Layer: Electron is required because DOM shims cannot model clipping or stacking contexts.
 * - Wait: visible editor, Explorer, link, and bubble locators; no timing sleeps.
 * - Artifacts: Playwright retains a trace and screenshot on failure.
 * - Maturity: experimental pending CI soak history.
 */

import { test, expect } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  cleanupMarkdownFixture,
  createMarkdownFixture,
  getActiveWorktreeContext,
  openMarkdownFixture,
  waitForRichMarkdownEditor
} from './helpers/markdown-ordered-list-exit'

const LINK_HREF = 'https://example.com/a/very/long/path/that/makes/the-link-bubble-wide'
const MARKDOWN = `# Rich markdown link overlay repro

This paragraph deliberately places the link near the right edge of the editor so its URL bubble reaches the Explorer boundary: alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau [hover this URL](${LINK_HREF}).
`

type OverlapHitTest = {
  bubbleRight: number
  explorerLeft: number
  overlapWidth: number
  topElementIsBubble: boolean
}

test.describe('Rich markdown link bubble stacking', () => {
  test('link actions stay above the right Explorer', async ({ orcaPage }, testInfo) => {
    await orcaPage.setViewportSize({ width: 1920, height: 1080 })
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)

    const context = await getActiveWorktreeContext(orcaPage)
    let filePath: string | null = null

    try {
      filePath = await createMarkdownFixture(
        context,
        'link-bubble-stacking',
        testInfo.workerIndex,
        MARKDOWN
      )
      await openMarkdownFixture(orcaPage, context, filePath)
      await waitForRichMarkdownEditor(orcaPage)

      await orcaPage.evaluate(() => {
        const store = window.__store
        if (!store) {
          throw new Error('window.__store is not available — is the app in dev mode?')
        }
        store.setState({
          rightSidebarOpen: true,
          rightSidebarTab: 'explorer',
          rightSidebarWidth: 780
        })
      })

      const explorer = orcaPage.locator('[data-orca-explorer-shell]')
      const link = orcaPage.locator(`.rich-markdown-editor a[href="${LINK_HREF}"]`)
      await expect(explorer).toBeVisible()
      await expect(link).toBeVisible()

      await link.click()

      const bubble = orcaPage.locator('.rich-markdown-link-bubble')
      await expect(bubble).toBeVisible()
      await expect(bubble.locator('.rich-markdown-link-url')).toContainText('https://example.com')

      const overlap = await orcaPage.evaluate((): OverlapHitTest => {
        const bubble = document.querySelector<HTMLElement>('.rich-markdown-link-bubble')
        const explorer = document.querySelector<HTMLElement>('[data-orca-explorer-shell]')
        if (!bubble || !explorer) {
          throw new Error('Link bubble or Explorer was not rendered')
        }

        const bubbleRect = bubble.getBoundingClientRect()
        const explorerRect = explorer.getBoundingClientRect()
        const overlapLeft = Math.max(bubbleRect.left, explorerRect.left)
        const overlapRight = Math.min(bubbleRect.right, explorerRect.right)
        const overlapWidth = Math.max(0, overlapRight - overlapLeft)
        const probeX = overlapLeft + Math.min(4, overlapWidth / 2)
        const probeY = bubbleRect.top + bubbleRect.height / 2
        const topElement = document.elementFromPoint(probeX, probeY)

        return {
          bubbleRight: bubbleRect.right,
          explorerLeft: explorerRect.left,
          overlapWidth,
          topElementIsBubble: topElement !== null && bubble.contains(topElement)
        }
      })

      expect(overlap.bubbleRight).toBeGreaterThan(overlap.explorerLeft)
      expect(overlap.overlapWidth).toBeGreaterThan(8)
      expect(overlap.topElementIsBubble).toBe(true)

      const editButton = bubble.getByTitle('Edit link')
      const editButtonBounds = await editButton.boundingBox()
      const explorerBounds = await explorer.boundingBox()
      expect(editButtonBounds).not.toBeNull()
      expect(explorerBounds).not.toBeNull()
      expect(editButtonBounds!.x + editButtonBounds!.width).toBeGreaterThan(explorerBounds!.x)
      await editButton.click()
      const input = bubble.locator('input')
      await expect(input).toBeFocused()
      await input.fill(`https://example.com/${'long-url-segment/'.repeat(30)}`)
      await input.press('End')
      expect(await input.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0)
      await expect(input).toBeFocused()
      await expect(bubble).toBeVisible()
      await orcaPage.keyboard.press('Escape')
      await expect(bubble.locator('.rich-markdown-link-url')).toBeVisible()

      await explorer.getByPlaceholder('Find files').click()
      await expect(bubble).toHaveCount(0)

      await orcaPage.getByRole('heading', { name: 'Rich markdown link overlay repro' }).click()
      await link.click()
      await expect(bubble).toBeVisible()
      const originalEditorZoom = await orcaPage.evaluate(() => {
        const store = window.__store
        if (!store) {
          throw new Error('window.__store is not available — is the app in dev mode?')
        }
        const zoom = store.getState().editorFontZoomLevel
        store.getState().setEditorFontZoomLevel(zoom + 1)
        return zoom
      })
      await expect(bubble).toHaveCount(0)
      await orcaPage.evaluate((zoom) => {
        window.__store?.getState().setEditorFontZoomLevel(zoom)
      }, originalEditorZoom)

      await orcaPage.getByRole('heading', { name: 'Rich markdown link overlay repro' }).click()
      await link.click()
      await expect(bubble).toBeVisible()
      await orcaPage.evaluate(() => {
        const store = window.__store
        if (!store) {
          throw new Error('window.__store is not available — is the app in dev mode?')
        }
        store.getState().setActiveView('settings')
      })
      await expect(bubble).toHaveCount(0)
    } finally {
      await cleanupMarkdownFixture(filePath)
    }
  })
})
