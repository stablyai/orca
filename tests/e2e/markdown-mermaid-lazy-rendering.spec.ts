import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Page } from '@stablyai/playwright-test'
import type mermaid from 'mermaid'
import { test, expect } from './helpers/orca-app'
import {
  cleanupMarkdownFixture,
  createMarkdownFixture,
  getActiveWorktreeContext,
  openMarkdownFixture
} from './helpers/markdown-editor-fixture'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

const diagram = `\`\`\`mermaid\nflowchart TD\n${Array.from(
  { length: 12 },
  (_, index) => `N${index}[Step ${index}] --> N${index + 1}[Step ${index + 1}]`
).join('\n')}\n\`\`\``
const prose = Array.from(
  { length: 80 },
  (_, index) => `Paragraph ${index}. Document context.\n`
).join('\n')
const content = `# Lazy diagrams\n\n[Jump to destination](#destination)\n\n${diagram}\n\n${prose}\n\n${diagram}\n\n## Destination\n\nNavigation target.\n\n${prose}\n\n${diagram}\n`

for (const surface of ['rich', 'preview'] as const) {
  for (const navigation of ['TOC', 'Find', 'anchor link'] as const) {
    test(`${surface} defers distant diagrams and keeps a ${navigation} destination visible as nearby diagrams render`, async ({
      orcaPage
    }, testInfo) => {
      await waitForSessionReady(orcaPage)
      await waitForActiveWorktree(orcaPage)
      const context = await getActiveWorktreeContext(orcaPage)
      const filePath = await createMarkdownFixture(
        context,
        'orca-e2e-mermaid-lazy-rendering',
        surface,
        testInfo.workerIndex,
        surface === 'rich' && navigation === 'anchor link'
          ? `---\ntitle: Anchor navigation\n---\n\n${content}`
          : content
      )
      try {
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
        const diagrams = document.locator('[data-mermaid-lazy]')
        await expect(diagrams).toHaveCount(3)
        await expect(diagrams.first().locator('svg')).toBeVisible()
        await expect(diagrams.nth(1).locator('svg')).toHaveCount(0)
        await expect(diagrams.nth(2).locator('svg')).toHaveCount(0)

        if (navigation === 'TOC') {
          await orcaPage.getByRole('button', { name: 'Table of Contents', exact: true }).click()
          await orcaPage.getByRole('button', { name: 'Destination', exact: true }).click()
        } else if (navigation === 'Find') {
          const searchRoot = surface === 'rich' ? document : orcaPage.locator('.markdown-preview')
          await searchRoot.press(process.platform === 'darwin' ? 'Meta+f' : 'Control+f')
          const search = orcaPage.getByRole('textbox', {
            name: surface === 'rich' ? 'Find in rich markdown editor' : 'Find in markdown preview',
            exact: true
          })
          if (surface === 'preview') {
            await search.fill('flowchart TD')
            await expect(orcaPage.locator('.markdown-preview-search-status')).toHaveText(
              'No results'
            )
            await expect(diagrams.nth(1).locator('svg')).toHaveCount(0)
          }
          await search.fill('Navigation target.')
        } else {
          await document.getByRole('link', { name: 'Jump to destination', exact: true }).click({
            modifiers:
              surface === 'rich' ? [process.platform === 'darwin' ? 'Meta' : 'Control'] : []
          })
        }
        await expect(diagrams.nth(1).locator('svg')).toHaveCount(1)
        const target =
          navigation === 'Find'
            ? document.getByText('Navigation target.', { exact: true })
            : document.getByRole('heading', { name: 'Destination', exact: true })
        await expect(target).toBeInViewport()
        await expect(diagrams.nth(2).locator('svg')).toHaveCount(0)

        if (navigation === 'Find') {
          await orcaPage.getByRole('button', { name: 'Close search', exact: true }).click()
        }
        if (navigation !== 'TOC') {
          await orcaPage.getByRole('button', { name: 'Table of Contents', exact: true }).click()
        }
        await orcaPage.getByRole('button', { name: 'Lazy diagrams', exact: true }).click()
        await expect(diagrams.first().locator('svg')).toBeInViewport()
        await expect(diagrams.nth(1).locator('svg')).toHaveCount(1)
        await expect(diagrams.nth(2).locator('svg')).toHaveCount(0)
        await orcaPage.screenshot({ path: testInfo.outputPath(`${surface}-lazy-diagrams.png`) })
      } finally {
        await cleanupMarkdownFixture(filePath)
      }
    })
  }
}

test('rich preserves the reading position when a skipped diagram renders above the viewport', async ({
  orcaPage
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  const context = await getActiveWorktreeContext(orcaPage)
  const filePath = await createMarkdownFixture(
    context,
    'orca-e2e-mermaid-lazy-rendering',
    'skipped-diagram',
    testInfo.workerIndex,
    `# Skip ahead\n\n${prose}\n${prose}\n${diagram}\n\n## Reader\n\nKeep this text in place.\n\n${prose}\n${prose}`
  )
  try {
    await openMarkdownFixture(orcaPage, context, filePath)
    const document = orcaPage.locator('.ProseMirror')
    const block = document.locator('[data-mermaid-lazy]')
    const target = document.getByRole('heading', { name: 'Reader', exact: true })
    await expect(block).toHaveCount(1)
    await expect(block.locator('svg')).toHaveCount(0)
    const initial = await target.evaluate((heading) => {
      const viewport = heading.closest<HTMLElement>('.rich-markdown-editor-shell .overflow-auto')
      const diagram = viewport?.querySelector('[data-mermaid-lazy]')
      if (!viewport || !diagram) {
        throw new Error('Missing reading viewport')
      }
      heading.scrollIntoView({ behavior: 'instant', block: 'start' })
      return {
        top: heading.getBoundingClientRect().top,
        viewportTop: viewport.getBoundingClientRect().top,
        diagramBottom: diagram.getBoundingClientRect().bottom,
        diagramHeight: diagram.getBoundingClientRect().height
      }
    })
    expect(initial.diagramBottom).toBeLessThanOrEqual(initial.viewportTop)
    await expect(block.locator('svg')).toHaveCount(1)
    expect(
      await block.evaluate((element) => element.getBoundingClientRect().height)
    ).toBeGreaterThan(initial.diagramHeight + 100)
    await expect
      .poll(async () => Math.abs((await target.boundingBox())!.y - initial.top))
      .toBeLessThan(2)
    await orcaPage.screenshot({ path: testInfo.outputPath('rich-skipped-diagram.png') })
  } finally {
    await cleanupMarkdownFixture(filePath)
  }
})

for (const reducedMotion of ['reduce', 'no-preference'] as const) {
  test(`rich ordinary anchors respect ${reducedMotion} motion preference`, async ({
    orcaPage
  }, testInfo) => {
    await orcaPage.emulateMedia({ reducedMotion })
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    const context = await getActiveWorktreeContext(orcaPage)
    const filePath = await createMarkdownFixture(
      context,
      'orca-e2e-mermaid-lazy-rendering',
      'ordinary-anchor',
      testInfo.workerIndex,
      `# Ordinary anchors\n\n[Jump to reader](#reader)\n\n${prose}\n${prose}\n## Reader\n\n${prose}`
    )
    try {
      await openMarkdownFixture(orcaPage, context, filePath)
      const document = orcaPage.locator('.ProseMirror')
      const target = document.getByRole('heading', { name: 'Reader', exact: true })
      const gap = () =>
        target.evaluate((heading) => {
          const viewport = heading.closest('.rich-markdown-editor-shell .overflow-auto')
          if (!viewport) {
            throw new Error('Missing anchor viewport')
          }
          return Math.abs(
            heading.getBoundingClientRect().top -
              viewport.getBoundingClientRect().top -
              (Number.parseFloat(getComputedStyle(heading).scrollMarginTop) || 0)
          )
        })
      await document.getByRole('link', { name: 'Jump to reader', exact: true }).click({
        modifiers: [process.platform === 'darwin' ? 'Meta' : 'Control']
      })
      if (reducedMotion === 'no-preference') {
        expect(await gap()).toBeGreaterThan(20)
      } else {
        expect(await gap()).toBeLessThan(2)
      }
      await expect.poll(gap).toBeLessThan(2)
    } finally {
      await cleanupMarkdownFixture(filePath)
    }
  })
}

test('preview Find still searches visible Mermaid error fallback source', async ({
  orcaPage
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  const context = await getActiveWorktreeContext(orcaPage)
  const source = 'flowchart TD\n  A[MERMAID_ERROR_SOURCE_SENTINEL'
  const filePath = await createMarkdownFixture(
    context,
    'orca-e2e-mermaid-lazy-rendering',
    'error-source-search',
    testInfo.workerIndex,
    `# Diagram error\n\n\`\`\`mermaid\n${source}\n\`\`\`\n`
  )
  try {
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
    await expect(preview.locator('.mermaid-error')).toBeVisible()
    await expect(preview.locator('.mermaid-block pre')).toHaveText(source)
    await preview.press(process.platform === 'darwin' ? 'Meta+f' : 'Control+f')
    await orcaPage
      .getByRole('textbox', { name: 'Find in markdown preview', exact: true })
      .fill('MERMAID_ERROR_SOURCE_SENTINEL')
    await expect(orcaPage.locator('.markdown-preview-search-status')).toHaveText(
      /[1-9]\d*\/[1-9]\d*/
    )
    await orcaPage.screenshot({ path: testInfo.outputPath('preview-error-source-search.png') })
  } finally {
    await cleanupMarkdownFixture(filePath)
  }
})

async function holdMermaidRendering(page: Page) {
  const assets = path.join(process.cwd(), 'out', 'renderer', 'assets')
  const entry = (await readdir(assets)).find((name) =>
    /^mermaid\.core-[A-Za-z0-9_-]+\.js$/.test(name)
  )
  if (!entry) {
    throw new Error('The built renderer has no Mermaid core entry')
  }
  return page.evaluateHandle(
    async (url) => {
      // The hashed browser chunk must be selected at runtime to share the renderer's real API.
      const module = await import(url)
      const api = Object.values(module).find(
        (value): value is Pick<typeof mermaid, 'render' | 'initialize'> =>
          value !== null &&
          typeof value === 'object' &&
          'render' in value &&
          typeof value.render === 'function' &&
          'initialize' in value &&
          typeof value.initialize === 'function'
      )
      if (!api) {
        throw new Error('The Mermaid core entry does not expose the real rendering API')
      }
      const original = api.render
      const barrier = Promise.withResolvers<void>()
      let calls = 0
      api.render = async (...args: Parameters<typeof original>) => {
        calls += 1
        await barrier.promise
        return original.apply(api, args)
      }
      return {
        calls: () => calls,
        release: () => barrier.resolve(),
        restore: () => {
          api.render = original
          barrier.resolve()
        }
      }
    },
    pathToFileURL(path.join(assets, entry)).href
  )
}

for (const navigation of ['TOC', 'Enter anchor'] as const) {
  test(`preview ${navigation} supersedes a pending Find reveal after real Mermaid rendering completes`, async ({
    orcaPage
  }, testInfo) => {
    await orcaPage.setViewportSize({ width: 1440, height: 900 })
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    const context = await getActiveWorktreeContext(orcaPage)
    const filePath = await createMarkdownFixture(
      context,
      'orca-e2e-mermaid-lazy-rendering',
      `pending-find-${navigation.replaceAll(' ', '-')}`,
      testInfo.workerIndex,
      `# Start\n\n${prose}\n\n${diagram}\n\n## Find destination\n\nFind this unique sentence.\n\n[Jump to start](#start)\n\n${prose}`
    )
    try {
      const renderGate = await holdMermaidRendering(orcaPage)
      try {
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
        const target = body.getByRole('heading', { name: 'Start', exact: true })
        const svg = body.locator('.mermaid-block svg')
        await expect(target).toBeInViewport()
        await expect(body.locator('[data-mermaid-lazy]')).toHaveCount(1)
        await expect(svg).toHaveCount(0)
        if (navigation === 'TOC') {
          await orcaPage.getByRole('button', { name: 'Table of Contents', exact: true }).click()
        }
        await preview.press(process.platform === 'darwin' ? 'Meta+f' : 'Control+f')
        const search = orcaPage.getByRole('textbox', {
          name: 'Find in markdown preview',
          exact: true
        })
        await search.fill('Find this unique sentence.')
        await expect(orcaPage.locator('.markdown-preview-search-status')).toHaveText('1/1')
        await expect.poll(() => renderGate.evaluate((gate) => gate.calls())).toBeGreaterThan(0)
        await expect(svg).toHaveCount(0)

        if (navigation === 'TOC') {
          await orcaPage.getByRole('button', { name: 'Start', exact: true }).click()
        } else {
          const link = body.getByRole('link', { name: 'Jump to start', exact: true })
          await link.focus()
          await link.press('Enter')
        }
        await expect(target).toBeInViewport()
        await expect(search).toHaveValue('Find this unique sentence.')
        const targetPosition = () =>
          target.evaluate((heading) => {
            const viewport = heading.closest<HTMLElement>('.markdown-preview')
            if (!viewport) {
              throw new Error('Missing preview navigation viewport')
            }
            return {
              scrollTop: viewport.scrollTop,
              headingTop: heading.getBoundingClientRect().top
            }
          })
        const before = await targetPosition()
        await renderGate.evaluate((gate) => gate.release())
        await expect(svg).toHaveCount(1)
        await orcaPage.evaluate(() => {
          const settled = Promise.withResolvers<void>()
          requestAnimationFrame(() => requestAnimationFrame(() => settled.resolve()))
          return settled.promise
        })
        const after = await targetPosition()
        await expect(target).toBeInViewport()
        expect(Math.abs(after.scrollTop - before.scrollTop)).toBeLessThan(2)
        expect(Math.abs(after.headingTop - before.headingTop)).toBeLessThan(2)
        await orcaPage.screenshot({
          path: testInfo.outputPath(`preview-${navigation.replaceAll(' ', '-')}-latest-target.png`)
        })
      } finally {
        await renderGate.evaluate((gate) => gate.restore()).finally(() => renderGate.dispose())
      }
    } finally {
      await cleanupMarkdownFixture(filePath)
    }
  })
}
