import { writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  cleanupMarkdownFixture,
  createMarkdownFixture,
  getActiveWorktreeContext,
  openMarkdownFixture,
  waitForRichMarkdownEditor
} from './helpers/markdown-editor-fixture'

test('restores the Markdown viewport when an image gains height after a tab switch', async ({
  orcaPage,
  registerPostElectronShutdownCleanup
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  const context = await getActiveWorktreeContext(orcaPage)
  const directory = '.orca-e2e-markdown-scroll'
  let filePath: string | null = null
  let otherPath: string | null = null
  let imagePath: string | null = null

  registerPostElectronShutdownCleanup(async () => {
    await cleanupMarkdownFixture(filePath)
    await cleanupMarkdownFixture(otherPath)
    if (imagePath) {
      await rm(imagePath, { force: true })
    }
  })

  const sections = Array.from(
    { length: 100 },
    (_, index) => `## Section ${index}\n\nParagraph ${index}. Scroll restoration testing text.`
  ).join('\n\n')
  filePath = await createMarkdownFixture(
    context,
    directory,
    'image-scroll',
    testInfo.workerIndex,
    `# Image scroll\n\n![Scroll restoration image](tall.svg)\n\n${sections}`
  )
  imagePath = path.join(path.dirname(filePath), 'tall.svg')
  await writeFile(
    imagePath,
    '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="1500"><rect width="400" height="1500" fill="gray"/></svg>'
  )
  otherPath = await createMarkdownFixture(
    context,
    directory,
    'other-tab',
    testInfo.workerIndex,
    '# Other tab'
  )
  await openMarkdownFixture(orcaPage, context, otherPath)
  await waitForRichMarkdownEditor(orcaPage)
  await openMarkdownFixture(orcaPage, context, filePath)
  const editor = await waitForRichMarkdownEditor(orcaPage)
  const image = editor.getByRole('img', { name: 'Scroll restoration image' })
  await expect
    .poll(() =>
      image.evaluate((element) => (element instanceof HTMLImageElement ? element.naturalHeight : 0))
    )
    .toBe(1500)
  const viewport = orcaPage.locator('.rich-markdown-editor-shell .overflow-auto')
  await viewport.evaluate((element) => {
    element.scrollTop = 4000
  })
  const heading = editor.getByRole('heading', { name: 'Section 45', exact: true })
  const originalTop = await heading.evaluate((element) => element.getBoundingClientRect().top)

  await orcaPage
    .locator('[data-tab-id]')
    .filter({ hasText: path.basename(otherPath) })
    .click()
  // Model image dimensions arriving after restoration, independent of the host's decode speed.
  const pendingImage = await orcaPage.addStyleTag({
    content: '.rich-markdown-editor img[alt="Scroll restoration image"] { height: 1px !important; }'
  })
  await orcaPage
    .locator('[data-tab-id]')
    .filter({ hasText: path.basename(filePath) })
    .click()
  await expect.poll(() => viewport.evaluate((element) => element.scrollTop)).toBe(4000)
  await pendingImage.evaluate((element) => element.remove())
  await expect
    .poll(() => image.evaluate((element) => element.getBoundingClientRect().height))
    .toBeGreaterThan(500)
  // Let Chromium apply its scroll-anchor adjustment before checking the final viewport.
  await viewport.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      })
  )
  await expect.poll(() => viewport.evaluate((element) => element.scrollTop)).toBe(4000)
  await expect
    .poll(() => heading.evaluate((element) => element.getBoundingClientRect().top))
    .toBeCloseTo(originalTop, 1)
})
