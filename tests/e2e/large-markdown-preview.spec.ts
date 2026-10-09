import { mkdir, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import {
  cleanupMarkdownFixture,
  createMarkdownFixture,
  expectSettledInViewport,
  getActiveWorktreeContext
} from './helpers/markdown-editor-fixture'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

const baseline = process.env.ORCA_MARKDOWN_CAPTURE_BASELINE === '1'
const proofDirectory = path.join(process.cwd(), 'validation-screenshots', 'large-markdown')

function largeDocument(): string {
  return (
    `# Large document\n\n[Jump to end](#destination) · [Global reference][later]\n\n` +
    `![Local image](preview.svg)\n\n` +
    `<details open><summary>Details</summary>\n\n**Nested content**\n\n</details>\n\n` +
    `$x^2$\n\n\`\`\`javascript\nconst visible = 42\n\`\`\`\n\n\`\`\`mermaid\ngraph LR\nA[Start] --> B[Finish]\n\`\`\`\n\n${Array.from(
      { length: 2000 },
      (_, index) =>
        `## Section ${index}\n\n${'Readable content with **emphasis** and a reference [link][later]. '.repeat(10)}\n\n` +
        '| Name | Value |\n| --- | --- |\n| Row | 42 |\n\n'
    ).join('')}# Destination\n\nUniqueEndMarker\n\n[later]: https://example.com\n`
  )
}

for (const width of [1920, 1280]) {
  test(`large preview renders bounded rows with global navigation and Find (${width}px)`, async ({
    orcaPage,
    electronApp,
    registerPostElectronShutdownCleanup
  }, testInfo) => {
    await orcaPage.setViewportSize({ width, height: width === 1920 ? 1200 : 720 })
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    const context = await getActiveWorktreeContext(orcaPage)
    const content = largeDocument()
    expect(Buffer.byteLength(content)).toBeGreaterThan(1024 * 1024)
    const filePath = await createMarkdownFixture(
      context,
      '.orca-e2e-large-preview',
      'large',
      testInfo.workerIndex,
      content
    )
    const imagePath = path.join(path.dirname(filePath), 'preview.svg')
    await writeFile(
      imagePath,
      '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="48"><rect width="240" height="48" fill="gray"/></svg>'
    )
    registerPostElectronShutdownCleanup(async () => {
      await cleanupMarkdownFixture(filePath)
      await rm(imagePath, { force: true })
    })
    await mkdir(proofDirectory, { recursive: true })
    orcaPage.on('console', (message) => {
      if (message.text().includes('PREVIEW_DIAGNOSTIC')) {
        console.log(message.text())
      }
    })
    await orcaPage.evaluate(() => {
      const OriginalWorker = window.Worker
      window.Worker = class extends OriginalWorker {
        constructor(...args: ConstructorParameters<typeof Worker>) {
          super(...args)
          this.addEventListener('error', (event) =>
            console.log('PREVIEW_DIAGNOSTIC', event.message)
          )
          this.addEventListener('message', (event) => {
            if (event.data.type === 'error') {
              console.log('PREVIEW_DIAGNOSTIC', event.data.message)
            }
          })
        }
      }
    })
    const errors: string[] = []
    orcaPage.on('pageerror', (error) => errors.push(error.message))
    await orcaPage.evaluate(() => {
      document.documentElement.dataset.previewMaxTask = '0'
      new PerformanceObserver((list) => {
        const max = Math.max(
          Number(document.documentElement.dataset.previewMaxTask),
          ...list.getEntries().map((entry) => entry.duration)
        )
        document.documentElement.dataset.previewMaxTask = String(max)
      }).observe({ type: 'longtask', buffered: false })
    })
    const started = Date.now()
    await orcaPage.evaluate(
      ({ filePath, relativePath, worktreeId }) => {
        window
          .__store!.getState()
          .openMarkdownPreview({ filePath, relativePath, worktreeId, language: 'markdown' })
      },
      {
        filePath,
        relativePath: path.relative(context.rootPath, filePath),
        worktreeId: context.worktreeId
      }
    )
    if (baseline) {
      await expect(orcaPage.getByText(/File is larger than the .* preview limit/)).toBeVisible()
      await orcaPage.screenshot({ path: path.join(proofDirectory, 'before.png') })
      return
    }
    const preview = orcaPage.locator('.markdown-preview')
    await expect(preview.getByRole('heading', { name: 'Large document', exact: true })).toBeVisible(
      {
        timeout: 25_000
      }
    )
    const elapsed = Date.now() - started
    await expect(
      preview.getByRole('link', { name: 'Global reference', exact: true })
    ).toHaveAttribute('href', 'https://example.com')
    await expect(preview.locator('.hljs')).toBeVisible()
    await expect(preview.locator('.katex')).toBeVisible()
    await expect(preview.getByText('Nested content', { exact: true })).toBeVisible()
    await expect
      .poll(() =>
        preview
          .getByRole('img', { name: 'Local image' })
          .evaluate((element) => (element instanceof HTMLImageElement ? element.naturalWidth : 0))
      )
      .toBe(240)
    await expect(preview.locator('.mermaid-block svg')).toBeVisible()
    const boundedCount = await preview.locator('*').count()
    expect(boundedCount).toBeLessThan(4000)
    expect(await preview.getByRole('heading', { name: 'Destination', exact: true }).count()).toBe(0)
    await orcaPage.screenshot({ path: path.join(proofDirectory, 'after.png') })
    const annotatedHeading = preview.locator('[data-annotation-block-key="h1:1-1"]')
    await expect(annotatedHeading).toBeVisible()
    await annotatedHeading.hover()
    await annotatedHeading.getByRole('button', { name: 'Add note', exact: true }).click()
    const composer = preview.getByPlaceholder('Add note for the AI')
    await composer.fill('Review the large document heading')
    await preview.getByRole('link', { name: 'Jump to end', exact: true }).click()
    await expect(composer).toHaveCount(1)
    await composer.press('Enter')
    await expect(composer).toHaveCount(0)

    await expect(preview.getByRole('heading', { name: 'Destination', exact: true })).toBeVisible()
    await expect(preview.getByText('UniqueEndMarker', { exact: true })).toBeVisible()
    await expect(annotatedHeading).toHaveCount(0)
    await orcaPage.getByRole('button', { name: 'Jump to first review note', exact: true }).click()
    await expect(annotatedHeading).toBeVisible()
    await expect(
      preview.getByText('Review the large document heading', { exact: true })
    ).toBeVisible()
    await preview.getByRole('link', { name: 'Jump to end', exact: true }).click()
    await expect(preview.getByText('UniqueEndMarker', { exact: true })).toBeVisible()
    await preview.focus()
    await orcaPage.keyboard.press(process.platform === 'darwin' ? 'Meta+f' : 'Control+f')
    const input = orcaPage.getByRole('textbox', { name: 'Find in markdown preview' })
    await input.fill('UniqueEndMarker')
    await expect(orcaPage.locator('.markdown-preview-search-status')).toHaveText('1/1', {
      timeout: 25_000
    })
    await expect(preview.getByText('UniqueEndMarker', { exact: true })).toBeVisible()
    await orcaPage.getByRole('button', { name: 'Next match', exact: true }).click()
    await expect(orcaPage.locator('.markdown-preview-search-status')).toHaveText('1/1')
    await input.fill('Section 1500')
    await expect(orcaPage.locator('.markdown-preview-search-status')).toHaveText('1/1', {
      timeout: 25_000
    })
    await expect(preview.getByRole('heading', { name: 'Section 1500', exact: true })).toBeVisible()
    await orcaPage.screenshot({ path: path.join(proofDirectory, 'find-offscreen.png') })
    await preview.evaluate((element) => {
      element.scrollTop += 1000
    })
    const manualScroll = await preview.evaluate((element) => element.scrollTop)
    await orcaPage.waitForTimeout(500)
    expect(await preview.evaluate((element) => element.scrollTop)).toBe(manualScroll)
    await expect(
      preview.getByRole('heading', { name: 'Section 1500', exact: true })
    ).not.toBeInViewport()
    await orcaPage.getByRole('button', { name: 'Close search', exact: true }).click()
    expect(await preview.locator('*').count()).toBeLessThan(4000)
    await orcaPage.getByRole('button', { name: 'Table of Contents', exact: true }).click()
    const toc = orcaPage.getByRole('complementary', { name: 'Table of contents', exact: true })
    await expect(toc.getByRole('button', { name: 'Section 0', exact: true })).toBeVisible()
    expect(await toc.locator('.markdown-toc-row').count()).toBeLessThan(100)
    await toc.getByRole('button', { name: 'Collapse Large document', exact: true }).click()
    await expect(toc.getByRole('button', { name: 'Section 0', exact: true })).toHaveCount(0)
    await toc.getByRole('button', { name: 'Destination', exact: true }).click()
    await expect(preview.getByRole('heading', { name: 'Destination', exact: true })).toBeVisible()
    await toc.getByRole('button', { name: 'Expand Large document', exact: true }).click()
    await toc.locator('.markdown-toc-list').evaluate((element) => {
      element.scrollTop = element.scrollHeight
    })
    await expect(toc.getByRole('button', { name: 'Section 1999', exact: true })).toBeVisible()
    await toc.getByRole('button', { name: 'Section 1999', exact: true }).click()
    await expect(preview.getByRole('heading', { name: 'Section 1999', exact: true })).toBeVisible()
    await orcaPage.evaluate(async () => {
      await window.__store!.getState().updateSettings({ theme: 'dark' })
    })
    await expect(preview).toHaveClass(/markdown-dark/)
    await orcaPage.screenshot({ path: path.join(proofDirectory, 'toc-dark.png') })
    await orcaPage.getByRole('button', { name: 'More actions', exact: true }).click()
    await expect(
      orcaPage.getByRole('menuitem', { name: 'Export as PDF', exact: true })
    ).toHaveAttribute('aria-disabled', 'true')
    await orcaPage.keyboard.press('Escape')
    const smallPath = await createMarkdownFixture(
      context,
      '.orca-e2e-large-preview',
      'small',
      testInfo.workerIndex,
      '# Ordinary preview'
    )
    registerPostElectronShutdownCleanup(() => cleanupMarkdownFixture(smallPath))
    const restoredHeading = preview.getByRole('heading', { name: 'Section 1999', exact: true })
    await expectSettledInViewport(restoredHeading)
    const originalTop = await restoredHeading.evaluate(
      (element) => element.getBoundingClientRect().top
    )
    await orcaPage.evaluate(
      ({ filePath, relativePath, worktreeId }) => {
        window
          .__store!.getState()
          .openMarkdownPreview({ filePath, relativePath, worktreeId, language: 'markdown' })
      },
      {
        filePath: smallPath,
        relativePath: path.relative(context.rootPath, smallPath),
        worktreeId: context.worktreeId
      }
    )
    await expect(
      orcaPage.getByRole('heading', { name: 'Ordinary preview', exact: true })
    ).toBeVisible()
    await expect(orcaPage.locator('[data-markdown-virtual-preview]')).toHaveCount(0)
    await orcaPage
      .locator('[data-tab-id]')
      .filter({ hasText: path.basename(filePath) })
      .click()
    await expect(preview.getByRole('heading', { name: 'Section 1999', exact: true })).toBeVisible({
      timeout: 25_000
    })
    await expect
      .poll(async () =>
        Math.abs(
          (await restoredHeading.evaluate((element) => element.getBoundingClientRect().top)) -
            originalTop
        )
      )
      .toBeLessThanOrEqual(2)
    await orcaPage.setViewportSize({ width, height: 1800 })
    await expect
      .poll(() =>
        preview
          .locator('[data-preview-block-loaded]')
          .first()
          .evaluate((node) =>
            node instanceof HTMLElement ? Number.parseFloat(node.style.minHeight) : 0
          )
      )
      .toBeGreaterThan(40)
    await expect
      .poll(() =>
        preview
          .locator('[data-preview-block-loaded]')
          .evaluateAll((nodes) =>
            nodes
              .slice(1)
              .some(
                (node, index) =>
                  node.getBoundingClientRect().top < nodes[index].getBoundingClientRect().bottom - 1
              )
          )
      )
      .toBe(false)
    await orcaPage.screenshot({ path: path.join(proofDirectory, `resized-${width}.png`) })
    const beforeRefresh = await restoredHeading.evaluate(
      (element) => element.getBoundingClientRect().top
    )
    await orcaPage.evaluate(
      ({ content }) => {
        const preview = document.querySelector('.markdown-preview')
        if (!preview) {
          throw new Error('Missing preview')
        }
        document.documentElement.dataset.previewCollapsed = 'false'
        const observer = new MutationObserver(() => {
          if (!preview.querySelector('[data-markdown-virtual-preview]')) {
            document.documentElement.dataset.previewCollapsed = 'true'
          }
        })
        observer.observe(preview, { childList: true, subtree: true })
        const state = window.__store!.getState()
        const file = state.openFiles.find((candidate) => candidate.id === state.activeFileId)
        if (!file) {
          throw new Error('Missing active file')
        }
        state.setEditorDraft(file.markdownPreviewSourceFileId ?? file.filePath, content)
      },
      { content: content.replace('## Section 1999', '## Updated section 1999') }
    )
    const updatedHeading = preview.getByRole('heading', {
      name: 'Updated section 1999',
      exact: true
    })
    await expect(updatedHeading).toBeInViewport({ timeout: 25_000 })
    await expect
      .poll(async () =>
        Math.abs(
          (await updatedHeading.evaluate((element) => element.getBoundingClientRect().top)) -
            beforeRefresh
        )
      )
      .toBeLessThanOrEqual(2)
    expect(await orcaPage.evaluate(() => document.documentElement.dataset.previewCollapsed)).toBe(
      'false'
    )
    await orcaPage.screenshot({ path: path.join(proofDirectory, `refreshed-${width}.png`) })
    const memory = await electronApp.evaluate(({ app }) =>
      app
        .getAppMetrics()
        .filter((entry) => entry.type === 'Tab')
        .map((entry) => entry.memory)
    )
    const maxTask = await orcaPage.evaluate(() =>
      Number(document.documentElement.dataset.previewMaxTask)
    )
    await writeFile(
      path.join(proofDirectory, 'measurements.json'),
      JSON.stringify(
        { bytes: Buffer.byteLength(content), elapsed, boundedCount, maxTask, memory },
        null,
        2
      )
    )
    expect(errors).toEqual([])
  })
}

test('oversized atomic blocks and files keep a usable fallback', async ({
  orcaPage,
  registerPostElectronShutdownCleanup
}, testInfo) => {
  test.skip(baseline)
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  const context = await getActiveWorktreeContext(orcaPage)
  const paths: string[] = []
  registerPostElectronShutdownCleanup(async () => {
    for (const file of paths) {
      await cleanupMarkdownFixture(file)
    }
  })
  for (const [slug, content] of [
    ['atomic', `# Atomic\n\n\`\`\`text\n${'x'.repeat(700_000)}\n\`\`\`\n\n# Still usable\n`],
    ['oversize', `# Over limit\n\n${'x'.repeat(8 * 1024 * 1024)}`]
  ]) {
    const filePath = await createMarkdownFixture(
      context,
      '.orca-e2e-large-preview',
      slug,
      testInfo.workerIndex,
      content
    )
    paths.push(filePath)
    await orcaPage.evaluate(
      ({ filePath, relativePath, worktreeId }) => {
        window
          .__store!.getState()
          .openMarkdownPreview({ filePath, relativePath, worktreeId, language: 'markdown' })
      },
      {
        filePath,
        relativePath: path.relative(context.rootPath, filePath),
        worktreeId: context.worktreeId
      }
    )
    if (slug === 'atomic') {
      await expect(
        orcaPage.getByText('This block is too large to render. Open source view to read it.')
      ).toBeVisible({ timeout: 25_000 })
      await expect(
        orcaPage.getByRole('heading', { name: 'Still usable', exact: true })
      ).toBeVisible()
    } else {
      await expect(orcaPage.getByText(/File is larger than the .* preview limit/)).toBeVisible()
      await expect(orcaPage.locator('[data-markdown-virtual-preview]')).toHaveCount(0)
    }
  }
})
