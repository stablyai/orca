import type { Locator, Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  cleanupMarkdownFixture,
  createMarkdownFixture,
  getActiveWorktreeContext,
  openMarkdownFixture,
  waitForRichMarkdownEditor
} from './helpers/markdown-editor-fixture'

const MARKDOWN = `\`\`\`bash
printf '%s\\n' "build complete" # bash-highlight-marker
\`\`\`

\`\`\`sh
printf '%s\\n' "build complete" # shell-control-marker
\`\`\`
`

async function switchToSourceMode(page: Page): Promise<void> {
  await page.evaluate(() => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is not available')
    }
    const state = store.getState()
    if (!state.activeFileId) {
      throw new Error('No active editor file')
    }
    state.setMarkdownViewMode(state.activeFileId, 'source')
  })
}

async function distinctLeafTokenColors(line: Locator): Promise<number> {
  return line.locator('span').evaluateAll((spans) => {
    const colors = spans
      .filter((span) => span.childElementCount === 0 && span.textContent?.trim())
      .map((span) => window.getComputedStyle(span).color)
    return new Set(colors).size
  })
}

test('highlights bash and sh fences in Markdown Source mode', async ({ orcaPage }, testInfo) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)

  const context = await getActiveWorktreeContext(orcaPage)
  let filePath: string | null = null

  try {
    filePath = await createMarkdownFixture(
      context,
      '.orca-e2e-markdown-source-highlighting',
      'bash-and-sh',
      testInfo.workerIndex,
      MARKDOWN
    )
    await openMarkdownFixture(orcaPage, context, filePath)
    await waitForRichMarkdownEditor(orcaPage)
    await switchToSourceMode(orcaPage)

    const monaco = orcaPage.locator('.monaco-editor').first()
    await expect(monaco).toBeVisible({ timeout: 25_000 })

    for (const marker of ['bash-highlight-marker', 'shell-control-marker']) {
      const line = monaco.locator('.view-line').filter({ hasText: marker })
      await expect(line).toHaveCount(1)
      await expect
        .poll(() => distinctLeafTokenColors(line), {
          message: `${marker} should render with distinct shell token colors`
        })
        .toBeGreaterThan(1)
    }
  } finally {
    await cleanupMarkdownFixture(filePath)
  }
})
