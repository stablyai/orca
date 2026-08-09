/**
 * Reliability contract:
 * - Invariant: Follow links turns plain Markdown-link clicks into bounded preview navigation.
 * - Failure source: editor remounts can lose pane-local state or create a permanent tab per hop.
 * - Oracle: the pressed toolbar state survives A -> B -> C while one preview remains in the group.
 * - Layer: Electron is required because ProseMirror click routing and unified tabs meet here.
 * - Wait: visible headings, link bubble, pressed toggle, and tab-strip state.
 * - Artifacts: Playwright retains a trace and screenshot on failure.
 * - Maturity: experimental pending CI soak history.
 */

import path from 'node:path'
import type { Locator } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  cleanupMarkdownFixture,
  createMarkdownFixture,
  getActiveWorktreeContext,
  openMarkdownFixture,
  waitForRichMarkdownEditor
} from './helpers/markdown-ordered-list-exit'

async function clickVisibleInlineTarget(locator: Locator): Promise<void> {
  await expect(locator).toBeVisible()
  // Why: ProseMirror inline geometry never settles for Playwright actionability headlessly.
  await locator.click({ force: true })
}

test.describe('Rich Markdown Follow links', () => {
  test('follows a document chain through one replaceable preview', async ({
    orcaPage
  }, testInfo) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)

    const context = await getActiveWorktreeContext(orcaPage)
    const fixturePaths: string[] = []

    try {
      const thirdPath = await createMarkdownFixture(
        context,
        'follow-links-third',
        testInfo.workerIndex,
        '# Follow links third\n'
      )
      fixturePaths.push(thirdPath)
      const secondPath = await createMarkdownFixture(
        context,
        'follow-links-second',
        testInfo.workerIndex,
        `# Follow links second\n\n[Continue to third](./${path.basename(thirdPath)})\n`
      )
      fixturePaths.push(secondPath)
      const firstPath = await createMarkdownFixture(
        context,
        'follow-links-first',
        testInfo.workerIndex,
        `# Follow links first\n\n[Continue to second](./${path.basename(secondPath)})\n`
      )
      fixturePaths.push(firstPath)

      await openMarkdownFixture(orcaPage, context, firstPath)
      await waitForRichMarkdownEditor(orcaPage)

      const firstLink = orcaPage.getByRole('link', { name: 'Continue to second' })
      await expect(
        orcaPage.getByRole('heading', { name: 'Follow links first', level: 1 })
      ).toBeVisible()

      const editorHeader = orcaPage.locator('.editor-header')
      const followLinksButton = editorHeader.getByRole('button', {
        name: 'Follow links on click'
      })
      await expect(
        orcaPage.locator('.rich-markdown-editor-toolbar').getByRole('button', {
          name: 'Follow links on click'
        })
      ).toHaveCount(0)
      await expect(followLinksButton).toHaveAttribute('aria-pressed', 'false')
      await followLinksButton.click({ force: true })
      await expect(followLinksButton).toHaveAttribute('aria-pressed', 'true')
      await expect(orcaPage.locator('.rich-markdown-editor-shell')).toHaveAttribute(
        'data-follow-links',
        'true'
      )

      await clickVisibleInlineTarget(firstLink)
      await expect(
        orcaPage.getByRole('heading', { name: 'Follow links second', level: 1 })
      ).toBeVisible()
      await expect(followLinksButton).toHaveAttribute('aria-pressed', 'true')

      await clickVisibleInlineTarget(orcaPage.getByRole('link', { name: 'Continue to third' }))
      await expect(
        orcaPage.getByRole('heading', { name: 'Follow links third', level: 1 })
      ).toBeVisible()
      await expect(followLinksButton).toHaveAttribute('aria-pressed', 'true')

      const tabStrip = orcaPage.locator('[data-tab-group-strip-id]')
      await expect(
        tabStrip.locator('[data-tab-id]').filter({ hasText: path.basename(firstPath) })
      ).toBeVisible()
      await expect(
        tabStrip.locator('[data-tab-id]').filter({ hasText: path.basename(thirdPath) })
      ).toBeVisible()
      await expect(
        tabStrip.locator('[data-tab-id]').filter({ hasText: path.basename(secondPath) })
      ).toHaveCount(0)
    } finally {
      await Promise.all(fixturePaths.map((filePath) => cleanupMarkdownFixture(filePath)))
    }
  })
})
