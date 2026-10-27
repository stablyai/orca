import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import {
  cleanupMarkdownFixture,
  createMarkdownFixture,
  expectSettledInViewport,
  getActiveWorktreeContext
} from './helpers/markdown-editor-fixture'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

const proofDirectory = path.join(process.cwd(), 'validation-screenshots', 'large-markdown-tables')
const baseline = process.env.ORCA_MARKDOWN_CAPTURE_TABLE_BASELINE === '1'

function largeTable(): string {
  return `# Large table\n\n\`\`\`javascript\nconst needle = 42\nconst longLine = "${'x'.repeat(6000)}"; const FarCodeNeedle = 42\n\`\`\`\n\n| Item | Description | Reference |\n| --- | --- | --- |\n${Array.from({ length: 12_000 }, (_, index) => `| Item ${index} | ${'Readable table content. '.repeat(3)}${index === 11_999 ? 'TableEndMarker' : ''} | [Value ${index}][later] |`).join('\n')}\n\n[later]: https://example.com\n`
}

for (const width of [1920, 1280]) {
  test(`large single table keeps Find, aligned columns, review notes, and refresh (${width}px)`, async ({
    orcaPage,
    registerPostElectronShutdownCleanup
  }, testInfo) => {
    await orcaPage.setViewportSize({ width, height: 900 })
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    const context = await getActiveWorktreeContext(orcaPage)
    const content = largeTable()
    expect(Buffer.byteLength(content)).toBeGreaterThan(1024 * 1024)
    const filePath = await createMarkdownFixture(
      context,
      '.orca-e2e-large-table-preview',
      'table',
      testInfo.workerIndex,
      content
    )
    registerPostElectronShutdownCleanup(() => cleanupMarkdownFixture(filePath))
    await mkdir(proofDirectory, { recursive: true })
    const errors: string[] = []
    orcaPage.on('pageerror', (error) => errors.push(error.message))
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
    const preview = orcaPage.locator('.markdown-preview')
    await expect(preview.getByRole('heading', { name: 'Large table', exact: true })).toBeVisible({
      timeout: 25_000
    })
    if (baseline) {
      await expect(
        preview.getByText('This block is too large to render. Open source view to read it.')
      ).toBeVisible()
      await orcaPage.screenshot({ path: path.join(proofDirectory, `before-${width}.png`) })
      return
    }
    await expect(preview.getByRole('cell', { name: 'Item 0', exact: true })).toBeVisible()
    await expect(preview.getByRole('columnheader', { name: 'Item', exact: true })).toHaveCount(1)
    await expect(
      preview.getByText('This block is too large to render. Open source view to read it.')
    ).toHaveCount(0)
    await orcaPage.screenshot({ path: path.join(proofDirectory, `after-${width}.png`) })
    await preview.focus()
    await orcaPage.keyboard.press(process.platform === 'darwin' ? 'Meta+f' : 'Control+f')
    const input = orcaPage.getByRole('textbox', { name: 'Find in markdown preview' })
    await input.fill('const needle')
    await expect(orcaPage.locator('.markdown-preview-search-status')).toHaveText('1/1', {
      timeout: 25_000
    })
    await expect(preview.locator('.hljs')).toBeInViewport()
    await expect
      .poll(() =>
        orcaPage.evaluate(() => {
          const highlight = CSS.highlights.get('markdown-preview-search-active-match')
          return highlight ? [...highlight].map((range) => range.toString()).join('') : ''
        })
      )
      .toBe('const needle')
    await input.fill('FarCodeNeedle')
    await expect(orcaPage.locator('.markdown-preview-search-status')).toHaveText('1/1')
    await expect
      .poll(() =>
        orcaPage.evaluate(() => {
          const range = [...(CSS.highlights.get('markdown-preview-search-active-match') ?? [])][0]
          const pre = range?.startContainer.parentElement?.closest('pre')
          if (!(range instanceof Range) || !pre || range.toString() !== 'FarCodeNeedle') {
            return false
          }
          const match = range.getBoundingClientRect()
          const viewport = pre.getBoundingClientRect()
          return match.left >= viewport.left && match.right <= viewport.right
        })
      )
      .toBe(true)
    await input.fill('TableEndMarker')
    await expect(orcaPage.locator('.markdown-preview-search-status')).toHaveText('1/1', {
      timeout: 25_000
    })
    const lastCell = preview.getByRole('cell', { name: 'Item 11999', exact: true })
    await expectSettledInViewport(lastCell)
    await expect(preview.getByRole('link', { name: 'Value 11999', exact: true })).toHaveAttribute(
      'href',
      'https://example.com'
    )
    expect(await preview.locator('tr').count()).toBeLessThan(600)
    await preview.hover()
    await orcaPage.mouse.wheel(0, -5000)
    await expect(lastCell).not.toBeInViewport()
    await orcaPage.getByRole('button', { name: 'Next match', exact: true }).click()
    await expectSettledInViewport(lastCell)
    const annotation = preview
      .locator('[data-annotation-block-key]')
      .filter({ has: orcaPage.getByRole('cell', { name: 'Item 11999', exact: true }) })
    await annotation.hover()
    await annotation.getByRole('button', { name: 'Add note', exact: true }).click()
    const composer = preview.getByPlaceholder('Add note for the AI')
    await composer.fill('Review the final table rows')
    await composer.press('Enter')
    await expect(preview.getByText('Review the final table rows', { exact: true })).toBeVisible()
    await expectSettledInViewport(lastCell)
    await orcaPage.evaluate(
      (dark) => window.__store!.getState().updateSettings({ theme: dark ? 'dark' : 'light' }),
      width === 1280
    )
    await orcaPage.setViewportSize({ width: width - 120, height: 1100 })
    await expect
      .poll(() =>
        preview.locator('table[data-preview-table-start]').evaluateAll((tables) => {
          const widths = tables
            .map((table) => table.querySelector('td')?.getBoundingClientRect().width)
            .filter((value): value is number => value !== undefined)
          return widths.length > 1 && Math.max(...widths) - Math.min(...widths) < 1
        })
      )
      .toBe(true)
    // Narrower columns can wrap more lines; Find must still navigate to the final row.
    await input.fill('')
    await input.fill('TableEndMarker')
    await expectSettledInViewport(lastCell)
    await orcaPage.screenshot({ path: path.join(proofDirectory, `end-${width}.png`) })
    await input.fill('')
    await orcaPage.evaluate(
      (content) => {
        const state = window.__store!.getState()
        const file = state.openFiles.find((entry) => entry.id === state.activeFileId)
        if (!file) {
          throw new Error('Missing preview file')
        }
        state.setEditorDraft(file.markdownPreviewSourceFileId ?? file.filePath, content)
      },
      content
        .replace('TableEndMarker', 'TableEndUpdated')
        .replace('| Item 0 |', `| Item 0 ${'x'.repeat(9000)} |`)
    )
    await expectSettledInViewport(preview.getByText(/TableEndUpdated/))
    await orcaPage.screenshot({ path: path.join(proofDirectory, `refreshed-${width}.png`) })
    expect(errors).toEqual([])
  })
}
