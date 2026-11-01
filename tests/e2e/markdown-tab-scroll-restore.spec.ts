import { writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { RICH_MARKDOWN_MAX_SIZE_BYTES } from '../../src/shared/constants'
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
  await pendingImage.evaluate((element) => element.parentNode?.removeChild(element))
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

for (const variant of ['rich', 'preview', 'preview callout', 'rich edited'] as const) {
  const surface = variant === 'rich' || variant === 'rich edited' ? 'rich' : 'preview'
  const title =
    variant === 'rich edited'
      ? 'rich preserves the cached pixel offset after an external structural edit'
      : `${variant} returns to the same prose below a diagram without rendering it again`
  test(title, async ({ orcaPage, registerPostElectronShutdownCleanup }, testInfo) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    const context = await getActiveWorktreeContext(orcaPage)
    const diagram = `\`\`\`mermaid\nflowchart TD\n${Array.from(
      { length: 12 },
      (_, index) => `N${index}[Step ${index}] --> N${index + 1}[Step ${index + 1}]`
    ).join('\n')}\n\`\`\``
    const sections = Array.from(
      { length: 220 },
      (_, index) => `## Section ${index}\n\nParagraph ${index}. Reading position.`
    ).join('\n\n')
    const leadIn =
      variant === 'preview callout'
        ? `${Array.from({ length: 80 }, (_, index) => `Lead-in ${index}. Document context.\n`).join('\n')}\n\n${diagram}\n\n`
        : ''
    const markdown = `# Reading position\n\n${diagram}\n\n${leadIn}${sections}\n\n${diagram}`
    const filePath = await createMarkdownFixture(
      context,
      'orca-e2e-markdown-scroll',
      `${surface}-mermaid`,
      testInfo.workerIndex,
      surface === 'preview'
        ? `${variant === 'preview callout' ? '[!NOTE]\n\n' : ''}${markdown}`
            .split('\n')
            .map((line) => `> ${line}`)
            .join('\n')
        : markdown
    )
    const otherPath = await createMarkdownFixture(
      context,
      'orca-e2e-markdown-scroll',
      `${surface}-other`,
      testInfo.workerIndex,
      '# Other tab'
    )
    registerPostElectronShutdownCleanup(async () => {
      await cleanupMarkdownFixture(filePath)
      await cleanupMarkdownFixture(otherPath)
    })
    await openMarkdownFixture(orcaPage, context, otherPath)
    await (surface === 'rich'
      ? openMarkdownFixture(orcaPage, context, filePath)
      : orcaPage.evaluate(
          ({ filePath, relativePath, worktreeId }) => {
            window.__store!.getState().openMarkdownPreview({
              filePath,
              relativePath,
              worktreeId,
              language: 'markdown'
            })
          },
          {
            filePath,
            relativePath: path.relative(context.rootPath, filePath),
            worktreeId: context.worktreeId
          }
        ))
    const document = orcaPage.locator(surface === 'rich' ? '.ProseMirror' : '.markdown-body')
    const viewport = orcaPage.locator(
      surface === 'rich' ? '.rich-markdown-editor-shell .overflow-auto' : '.markdown-preview'
    )
    const diagrams = document.locator('[data-mermaid-lazy]')
    await expect(diagrams).toHaveCount(variant === 'preview callout' ? 3 : 2)
    await expect(diagrams.first().locator('svg')).toHaveCount(1)
    const diagramHeight = await diagrams
      .first()
      .locator('svg')
      .evaluate((svg) => svg.getBoundingClientRect().height)
    expect(diagramHeight).toBeGreaterThan(800)
    await expect(diagrams.last().locator('svg')).toHaveCount(0)
    if (variant === 'preview callout') {
      await diagrams.nth(1).scrollIntoViewIfNeeded()
      await expect(diagrams.nth(1).locator('svg')).toHaveCount(1)
    }
    const heading = document.getByRole('heading', { name: 'Section 80', exact: true })
    let originalPosition: number
    if (variant === 'rich edited') {
      const pendingHeight = await diagrams
        .last()
        .evaluate((node) => node.getBoundingClientRect().height)
      originalPosition = await viewport.evaluate(
        (container, { diagramHeight, pendingHeight }) => {
          container.scrollTop =
            container.scrollHeight - container.clientHeight - diagramHeight + pendingHeight / 2
          return container.scrollTop
        },
        { diagramHeight, pendingHeight }
      )
    } else {
      originalPosition = await heading.evaluate((element) => {
        element.scrollIntoView({ block: 'start', behavior: 'instant' })
        return element.getBoundingClientRect().top
      })
    }
    await orcaPage
      .locator('[data-tab-id]')
      .filter({ hasText: path.basename(otherPath) })
      .click()
    await expect(orcaPage.getByRole('heading', { name: 'Other tab', exact: true })).toBeVisible()
    if (variant === 'rich edited') {
      await writeFile(
        filePath,
        markdown
          .replace('# Reading position', '# Updated reading position')
          .replaceAll('## Section', 'Section')
          .replaceAll('Paragraph ', '## Paragraph ')
      )
      await orcaPage.evaluate((filePath) => {
        const file = window
          .__store!.getState()
          .openFiles.find((entry) => entry.filePath === filePath)
        if (!file) {
          throw new Error('Missing edited Markdown fixture')
        }
        window.dispatchEvent(
          new CustomEvent('orca:editor-file-cache-stale', { detail: { fileId: file.id } })
        )
      }, filePath)
    }
    await orcaPage
      .locator('[data-tab-id]')
      .filter({ hasText: path.basename(filePath) })
      .click()
    if (variant === 'rich edited') {
      await expect(
        document.getByRole('heading', { name: 'Updated reading position', exact: true })
      ).toHaveCount(1)
      await expect
        .poll(() => viewport.evaluate((node) => node.scrollHeight - node.clientHeight))
        .toBeGreaterThan(originalPosition)
    }
    await expect
      .poll(async () => {
        const position =
          variant === 'rich edited'
            ? await viewport.evaluate((node) => node.scrollTop)
            : await heading.evaluate((node) => node.getBoundingClientRect().top)
        return Math.abs(position - originalPosition)
      })
      .toBeLessThan(2)
    if (variant !== 'rich edited') {
      await expect(diagrams.locator('svg')).toHaveCount(0)
    }
    await orcaPage.screenshot({ path: testInfo.outputPath(`${surface}-mermaid-tab-return.png`) })
  })
}

test('normal preview preserves the newer position after virtual preview takes ownership', async ({
  orcaPage,
  registerPostElectronShutdownCleanup
}, testInfo) => {
  await orcaPage.setViewportSize({ width: 1440, height: 900 })
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  const context = await getActiveWorktreeContext(orcaPage)
  const diagram = `\`\`\`mermaid\nflowchart TD\n${Array.from(
    { length: 12 },
    (_, index) => `N${index}[Step ${index}] --> N${index + 1}[Step ${index + 1}]`
  ).join('\n')}\n\`\`\``
  const normal = `# Mode transition\n\n${diagram}\n\n${Array.from(
    { length: 220 },
    (_, index) => `## Section ${index}\n\nParagraph ${index}. Mode transition.\n`
  ).join('\n')}`
  const filler = `${'Additional virtual-only content. '.repeat(70)}\n\n`
  const large = `${normal}\n\n${filler.repeat(Math.ceil(RICH_MARKDOWN_MAX_SIZE_BYTES / filler.length) + 1)}`
  const filePath = await createMarkdownFixture(
    context,
    'orca-e2e-markdown-scroll',
    'preview-mode',
    testInfo.workerIndex,
    normal
  )
  const otherPath = await createMarkdownFixture(
    context,
    'orca-e2e-markdown-scroll',
    'preview-mode-other',
    testInfo.workerIndex,
    '# Other tab'
  )
  registerPostElectronShutdownCleanup(async () => {
    await cleanupMarkdownFixture(filePath)
    await cleanupMarkdownFixture(otherPath)
  })
  await openMarkdownFixture(orcaPage, context, otherPath)
  await orcaPage.evaluate(
    ({ filePath, relativePath, worktreeId }) => {
      window.__store!.getState().openMarkdownPreview({
        filePath,
        relativePath,
        worktreeId,
        language: 'markdown'
      })
    },
    {
      filePath,
      relativePath: path.relative(context.rootPath, filePath),
      worktreeId: context.worktreeId
    }
  )
  const preview = orcaPage.locator('.markdown-preview')
  const body = preview.locator('.markdown-body')
  await expect(body.locator('.mermaid-block svg')).toHaveCount(1)
  await body
    .getByRole('heading', { name: 'Section 20', exact: true })
    .evaluate((node) => node.scrollIntoView({ block: 'start', behavior: 'instant' }))
  const originalPosition = await preview.evaluate((node) => node.scrollTop)
  const replaceHiddenContent = async (content: string): Promise<void> => {
    await orcaPage
      .locator('[data-tab-id]')
      .filter({ hasText: path.basename(otherPath) })
      .click()
    await expect(orcaPage.getByRole('heading', { name: 'Other tab', exact: true })).toBeVisible()
    await writeFile(filePath, content)
    await orcaPage.evaluate((filePath) => {
      const file = window.__store!.getState().openFiles.find((entry) => entry.filePath === filePath)
      if (!file) {
        throw new Error('Missing preview mode fixture')
      }
      window.dispatchEvent(
        new CustomEvent('orca:editor-file-cache-stale', { detail: { fileId: file.id } })
      )
    }, filePath)
    await orcaPage
      .locator('[data-tab-id]')
      .filter({ hasText: path.basename(filePath) })
      .click()
  }
  await replaceHiddenContent(large)
  await expect(body).toHaveAttribute('data-markdown-preview-incomplete', 'true')
  await preview.press(process.platform === 'darwin' ? 'Meta+f' : 'Control+f')
  await orcaPage
    .getByRole('textbox', { name: 'Find in markdown preview', exact: true })
    .fill('Paragraph 80. Mode transition.')
  await expect(orcaPage.locator('.markdown-preview-search-status')).toHaveText('1/1')
  await expect(body.getByText('Paragraph 80. Mode transition.', { exact: true })).toBeInViewport()
  await orcaPage.getByRole('button', { name: 'Close search', exact: true }).click()
  await orcaPage.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
  )
  const latestPosition = await preview.evaluate((node) => node.scrollTop)
  expect(Math.abs(latestPosition - originalPosition)).toBeGreaterThan(1000)
  await replaceHiddenContent(normal)
  await expect(body).not.toHaveAttribute('data-markdown-preview-incomplete', 'true')
  await expect(body.getByRole('heading', { name: 'Section 219', exact: true })).toHaveCount(1)
  await expect
    .poll(() => preview.evaluate((node) => node.scrollHeight - node.clientHeight))
    .toBeGreaterThan(latestPosition)
  await expect
    .poll(async () => Math.abs((await preview.evaluate((node) => node.scrollTop)) - latestPosition))
    .toBeLessThan(2)
  await orcaPage.screenshot({ path: testInfo.outputPath('preview-mode-reading-position.png') })
})
