import { readFileSync } from 'node:fs'
import { test, expect } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  cleanupMarkdownFixture,
  createMarkdownFixture,
  getActiveWorktreeContext,
  openMarkdownFixture
} from './helpers/markdown-editor-fixture'

const SOURCE = '# Saved title\n\n[Reference][id]\n\n[id]: https://example.com\n'

test('fallback preview shows the unsaved draft', async ({ orcaPage }, testInfo) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  const context = await getActiveWorktreeContext(orcaPage)
  const file = await createMarkdownFixture(
    context,
    'markdown-preview',
    'draft',
    testInfo.workerIndex,
    SOURCE
  )
  try {
    await openMarkdownFixture(orcaPage, context, file)
    const openPreview = orcaPage.getByRole('button', { name: 'Open preview', exact: true })
    await expect(openPreview).toBeVisible()
    const monaco = orcaPage.locator('.monaco-editor').first()
    await monaco.click()
    await orcaPage.keyboard.press('ControlOrMeta+Home')
    await orcaPage.keyboard.press('ControlOrMeta+A')
    await orcaPage.keyboard.insertText(SOURCE.replace('Saved title', 'Unsaved draft'))
    await expect(monaco).toContainText('Unsaved draft')
    await expect(openPreview).toBeVisible()
    expect(readFileSync(file, 'utf8')).toBe(SOURCE)
    await testInfo.attach('before-preview', {
      body: await orcaPage.screenshot({ path: testInfo.outputPath('before-preview.png') }),
      contentType: 'image/png'
    })
    await openPreview.click()
    await expect(
      orcaPage.getByRole('heading', { name: 'Unsaved draft', exact: true })
    ).toBeVisible()
    await expect(orcaPage.getByRole('link', { name: 'Reference', exact: true })).toHaveAttribute(
      'href',
      'https://example.com'
    )
    expect(readFileSync(file, 'utf8')).toBe(SOURCE)
    await testInfo.attach('after-preview', {
      body: await orcaPage.screenshot({ path: testInfo.outputPath('after-preview.png') }),
      contentType: 'image/png'
    })
  } finally {
    await cleanupMarkdownFixture(file)
  }
})
