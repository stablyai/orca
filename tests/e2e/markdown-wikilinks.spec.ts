import path from 'path'
import { rm, writeFile } from 'fs/promises'
import { test, expect } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  cleanupMarkdownFixture,
  createMarkdownFixture,
  getActiveWorktreeContext,
  openMarkdownFixture,
  waitForRichMarkdownEditor
} from './helpers/markdown-ordered-list-exit'

async function getRichMarkdownSource(page: Parameters<typeof waitForRichMarkdownEditor>[0]) {
  return page.evaluate(() => {
    const editor = document.querySelector('.rich-markdown-editor') as
      | (Element & {
          editor?: {
            getMarkdown?: () => string
          }
        })
      | null
    return editor?.editor?.getMarkdown?.() ?? null
  })
}

async function clickDocLink(page: Parameters<typeof waitForRichMarkdownEditor>[0], text: string) {
  await page
    .locator('.rich-markdown-doc-link', { hasText: text })
    .first()
    .click({
      modifiers: ['Control', 'Meta']
    })
}

test.describe('Markdown wikilinks', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
  })

  test('preserves wikilink syntax and opens an existing target', async ({ orcaPage }, testInfo) => {
    const context = await getActiveWorktreeContext(orcaPage)
    const filesToClean: string[] = []

    try {
      const targetName = `wikilink-target-${testInfo.workerIndex}-${Date.now()}`
      const targetFilePath = path.join(context.rootPath, `${targetName}.md`)
      await writeFile(
        targetFilePath,
        '# Target Note\n\n## Target Heading\n\nBlock content ^block-id\n'
      )
      filesToClean.push(targetFilePath)
      const sourceMarkdown = [
        '# Source',
        '',
        `See [[${targetName}|Target alias]], [[${targetName}#Target Heading]], and [[${targetName}#^block-id]].`,
        '',
        `Embed ![[${targetName}#^block-id]].`,
        '',
        '`[[not-a-link]]`',
        ''
      ].join('\n')
      const sourceFilePath = await createMarkdownFixture(
        context,
        'wikilink-source',
        testInfo.workerIndex,
        sourceMarkdown
      )
      filesToClean.push(sourceFilePath)

      await openMarkdownFixture(orcaPage, context, sourceFilePath)
      await waitForRichMarkdownEditor(orcaPage)

      await expect(orcaPage.locator('.rich-markdown-doc-link')).toHaveCount(4, { timeout: 5_000 })
      await expect(
        orcaPage.locator('.rich-markdown-doc-link', { hasText: 'Target alias' })
      ).toBeVisible()

      await expect
        .poll(async () => getRichMarkdownSource(orcaPage), {
          timeout: 10_000,
          message: 'rich markdown source did not preserve wikilink syntax'
        })
        .toContain(`![[${targetName}#^block-id]]`)
      await expect.poll(async () => getRichMarkdownSource(orcaPage)).toContain('`[[not-a-link]]`')

      await clickDocLink(orcaPage, 'Target alias')

      await expect
        .poll(
          async () =>
            orcaPage.evaluate(() => {
              const state = window.__store?.getState()
              return state?.openFiles.find((file) => file.id === state.activeFileId)?.filePath
            }),
          { timeout: 5_000, message: 'existing wikilink target did not become active' }
        )
        .toBe(targetFilePath)
    } finally {
      await Promise.all(filesToClean.map((filePath) => cleanupMarkdownFixture(filePath)))
    }
  })

  test('offers to create a missing wikilink target', async ({ orcaPage }, testInfo) => {
    const context = await getActiveWorktreeContext(orcaPage)
    const missingTarget = `wikilink-missing-${testInfo.workerIndex}-${Date.now()}`
    const missingTargetPath = path.join(context.rootPath, `${missingTarget}.md`)
    let sourceFilePath: string | null = null

    try {
      sourceFilePath = await createMarkdownFixture(
        context,
        'wikilink-missing-source',
        testInfo.workerIndex,
        `# Source\n\nCreate [[${missingTarget}]].\n`
      )
      await openMarkdownFixture(orcaPage, context, sourceFilePath)
      await waitForRichMarkdownEditor(orcaPage)

      await clickDocLink(orcaPage, missingTarget)
      await expect(orcaPage.getByText('Note not found')).toBeVisible({ timeout: 5_000 })
      await orcaPage.getByRole('button', { name: 'Create note' }).click()

      await expect
        .poll(
          async () =>
            orcaPage.evaluate(() => {
              const state = window.__store?.getState()
              return state?.openFiles.find((file) => file.id === state.activeFileId)?.filePath
            }),
          { timeout: 5_000, message: 'created wikilink target did not become active' }
        )
        .toBe(missingTargetPath)

      await expect
        .poll(
          async () => {
            const source = await getRichMarkdownSource(orcaPage)
            return source?.trimEnd() ?? null
          },
          {
            timeout: 10_000,
            message: 'created wikilink target did not load with initial heading'
          }
        )
        .toBe(`# ${missingTarget}`)
    } finally {
      await cleanupMarkdownFixture(sourceFilePath)
      await rm(missingTargetPath, { force: true })
    }
  })
})
