import path from 'node:path'
import type { Locator, Page } from '@stablyai/playwright-test'
import { test as nativeTest, expect } from './helpers/orca-app'
import {
  cleanupMarkdownFixture,
  createMarkdownFixture,
  expectSettledInViewport,
  getActiveWorktreeContext,
  openMarkdownFixture,
  type ActiveWorktreeContext
} from './helpers/markdown-editor-fixture'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { holdMermaidRendering } from './helpers/mermaid-render-gate'

const directory = '.orca-e2e-deferred-find'
const alpha = 'DeferredAlphaNeedle'
const beta = 'DeferredBetaNeedle'
const replacementNeedle = 'ReplacementOnlyNeedle'
const prose = (count: number) =>
  Array.from(
    { length: count },
    (_, index) => `Paragraph ${index}. Ordinary reading context without diagram labels.`
  ).join('\n\n')
const diagrams = [alpha, beta].map(
  (label) => `\`\`\`mermaid\nflowchart TD\n  A["${label}"] --> Z["Neutral ending"]\n\`\`\``
)

async function openPreview(page: Page, context: ActiveWorktreeContext, filePath: string) {
  await page.evaluate(
    ({ filePath, relativePath, worktreeId }) =>
      window.__store!.getState().openMarkdownPreview({
        filePath,
        relativePath,
        worktreeId,
        language: 'markdown'
      }),
    {
      filePath,
      relativePath: path.relative(context.rootPath, filePath),
      worktreeId: context.worktreeId
    }
  )
}

type Scene = {
  page: Page
  preview: Locator
  body: Locator
  search: Locator
  status: Locator
  gate: Awaited<ReturnType<typeof holdMermaidRendering>>
}

async function highlights(page: Page) {
  return page.evaluate(() => {
    const ranges = [...(CSS.highlights.get('markdown-preview-search-active-match') ?? [])]
    return {
      active: ranges.map((range) => {
        if (!(range instanceof Range)) {
          throw new Error('The active CSS Highlight must contain a DOM Range')
        }
        const owner = range.startContainer.parentElement
        const viewport = owner?.closest('.markdown-preview')?.getBoundingClientRect()
        const bounds = range.getBoundingClientRect()
        return {
          text: range.toString(),
          connected: range.startContainer.isConnected && range.endContainer.isConnected,
          diagram: Boolean(owner?.closest('.mermaid-block svg')),
          visible: Boolean(
            viewport &&
            bounds.width > 0 &&
            bounds.height > 0 &&
            bounds.top >= viewport.top &&
            bounds.bottom <= viewport.bottom
          )
        }
      }),
      matches: [...(CSS.highlights.get('markdown-preview-search-match') ?? [])].map((range) =>
        range.toString()
      )
    }
  })
}

async function position(target: Locator) {
  return target.evaluate((element) => {
    const viewport = element.closest<HTMLElement>('.markdown-preview')
    if (!viewport) {
      throw new Error('Missing normal preview reading viewport')
    }
    return { scrollTop: viewport.scrollTop, targetTop: element.getBoundingClientRect().top }
  })
}

async function release(scene: Scene, svgCount?: number) {
  await scene.gate.evaluate((gate) => gate.release())
  await expect
    .poll(() =>
      scene.gate.evaluate((gate) => gate.calls() > 0 && gate.completed() === gate.calls())
    )
    .toBe(true)
  if (svgCount !== undefined) {
    await expect(scene.body.locator('.mermaid-block svg')).toHaveCount(svgCount)
  }
  await scene.page.evaluate(() => {
    const settled = Promise.withResolvers<void>()
    requestAnimationFrame(() => requestAnimationFrame(() => settled.resolve()))
    return settled.promise
  })
}

async function queryWhileHeld(scene: Scene, query: string) {
  if (!(await scene.search.isVisible())) {
    await scene.preview.press(process.platform === 'darwin' ? 'Meta+f' : 'Control+f')
  }
  await scene.search.fill(query)
  await expect(scene.search).toHaveValue(query)
  await expect(scene.status).toHaveText('Searching…')
  await expect(scene.preview.locator('.markdown-preview-search')).toHaveAttribute(
    'aria-busy',
    'true'
  )
  await expect.poll(() => scene.gate.evaluate((gate) => gate.calls())).toBeGreaterThan(0)
  await expect(scene.body.locator('.mermaid-block svg')).toHaveCount(0)
  expect((await highlights(scene.page)).active).toEqual([])
}

async function selected(scene: Scene, text: string, inDiagram = true) {
  await expect(scene.status).toHaveText('1/1')
  await expect(scene.preview.locator('.markdown-preview-search')).not.toHaveAttribute(
    'aria-busy',
    'true'
  )
  await expect
    .poll(async () => (await highlights(scene.page)).active)
    .toEqual([{ text, connected: true, diagram: inDiagram, visible: true }])
  await expect.poll(async () => (await highlights(scene.page)).matches).toEqual([text])
}

const test = nativeTest.extend<{ scene: Scene }>({
  scene: async ({ orcaPage, registerPostElectronShutdownCleanup }, provideFixture, testInfo) => {
    const paths: string[] = []
    registerPostElectronShutdownCleanup(async () => {
      await Promise.all(paths.map((filePath) => cleanupMarkdownFixture(filePath)))
    })
    let gate: Scene['gate'] | undefined
    const slug = testInfo.title.split(' ')[0]
    try {
      await orcaPage.setViewportSize({ width: 1440, height: 900 })
      await orcaPage.emulateMedia({ reducedMotion: 'reduce' })
      await waitForSessionReady(orcaPage)
      await waitForActiveWorktree(orcaPage)
      const context = await getActiveWorktreeContext(orcaPage)
      const replacementPath = await createMarkdownFixture(
        context,
        directory,
        'replacement',
        testInfo.workerIndex,
        `# Replacement reading\n\n${prose(90)}\n\n${replacementNeedle}\n\n${prose(90)}\n\n${alpha}\n`
      )
      paths.push(replacementPath)
      const href = path
        .relative(path.join(context.rootPath, directory), replacementPath)
        .split(path.sep)
        .join('/')
      const sourcePath = await createMarkdownFixture(
        context,
        directory,
        slug,
        testInfo.workerIndex,
        `# Reading origin\n\n[Continue reading](#reading-marker)\n\n[Open replacement](${href})\n\n${prose(16)}\n\n## Reading marker\n\n${prose(90)}\n\n${diagrams[0]}\n\n${prose(90)}\n\n${diagrams[1]}\n\n${prose(25)}\n`
      )
      paths.push(sourcePath)
      gate = await holdMermaidRendering(orcaPage)
      await openPreview(orcaPage, context, sourcePath)
      const preview = orcaPage.locator('.markdown-preview:visible')
      const body = preview.locator('.markdown-body')
      const scene: Scene = {
        page: orcaPage,
        preview,
        body,
        gate,
        search: orcaPage.getByRole('textbox', { name: 'Find in markdown preview', exact: true }),
        status: preview.locator('.markdown-preview-search-status')
      }
      await expect(
        body.getByRole('heading', { name: 'Reading origin', exact: true })
      ).toBeInViewport()
      await expect(body).not.toHaveAttribute('data-markdown-preview-incomplete', 'true')
      await expect(body.locator('[data-mermaid-lazy]')).toHaveCount(2)
      await expect(body.locator('[data-mermaid-lazy]').first()).not.toBeInViewport()
      await expect(body.locator('[data-mermaid-lazy]').last()).not.toBeInViewport()
      await expect(body.locator('.mermaid-block svg')).toHaveCount(0)
      await expect(body).not.toContainText(alpha)
      await expect(body).not.toContainText(beta)
      expect(await gate.evaluate((held) => held.calls())).toBe(0)
      await provideFixture(scene)
    } finally {
      if (gate) {
        await gate.evaluate((held) => held.restore()).finally(() => gate!.dispose())
      }
    }
  }
})

test('offscreen Mermaid label is found and scrolled into normal preview', async ({ scene }) => {
  await queryWhileHeld(scene, alpha)
  await release(scene, 2)
  await selected(scene, alpha)
  await expect(
    scene.body.locator('.mermaid-block svg').first().getByText(alpha, { exact: true })
  ).toBeInViewport()
  await expect(scene.body.locator('[data-mermaid-lazy]').last()).not.toBeInViewport()
})

test('newer Find query owns the actual active Range and navigation after rendering', async ({
  scene
}) => {
  const origin = scene.body.getByRole('heading', { name: 'Reading origin', exact: true })
  const before = await position(origin)
  await queryWhileHeld(scene, alpha)
  await queryWhileHeld(scene, beta)
  await release(scene, 2)
  await selected(scene, beta)
  await expect(scene.search).toHaveValue(beta)
  await expect(
    scene.body.locator('.mermaid-block svg').last().getByText(beta, { exact: true })
  ).toBeInViewport()
  await expect(scene.body.locator('[data-mermaid-lazy]').first()).not.toBeInViewport()
  const after = await position(origin)
  expect(after.scrollTop).toBeGreaterThan(before.scrollTop + 1000)
})

test('closed Find cannot resurrect highlights or move the original reading offset', async ({
  scene
}) => {
  const reader = scene.body.getByRole('heading', { name: 'Reading marker', exact: true })
  await scene.body.getByRole('link', { name: 'Continue reading', exact: true }).click()
  await expectSettledInViewport(reader)
  const before = await position(reader)
  expect(before.scrollTop).toBeGreaterThan(100)
  await queryWhileHeld(scene, alpha)
  await scene.page.getByRole('button', { name: 'Close search', exact: true }).click()
  await expect(scene.search).toHaveCount(0)
  await release(scene)
  await expect(scene.search).toHaveCount(0)
  await expect(scene.preview.locator('.markdown-preview-search')).toHaveCount(0)
  expect(await highlights(scene.page)).toEqual({ active: [], matches: [] })
  const after = await position(reader)
  expect(Math.abs(after.scrollTop - before.scrollTop)).toBeLessThanOrEqual(2)
  expect(Math.abs(after.targetTop - before.targetTop)).toBeLessThanOrEqual(2)
})

test('replacement Markdown keeps its own search and reading position when the old render finishes', async ({
  scene
}) => {
  await queryWhileHeld(scene, alpha)
  await scene.body.getByRole('link', { name: 'Open replacement', exact: true }).click()
  await expect(
    scene.body.getByRole('heading', { name: 'Replacement reading', exact: true })
  ).toBeInViewport()
  await expect(
    scene.body.getByRole('heading', { name: 'Reading origin', exact: true })
  ).toHaveCount(0)
  await expect(scene.body.locator('[data-mermaid-lazy]')).toHaveCount(0)
  await scene.preview.press(process.platform === 'darwin' ? 'Meta+f' : 'Control+f')
  await scene.search.fill(replacementNeedle)
  await selected(scene, replacementNeedle, false)
  const target = scene.body.getByText(replacementNeedle, { exact: true })
  await expectSettledInViewport(target)
  const before = await position(target)
  await release(scene)
  await expect(scene.search).toHaveValue(replacementNeedle)
  await selected(scene, replacementNeedle, false)
  await expect(
    scene.body.getByRole('heading', { name: 'Replacement reading', exact: true })
  ).toHaveCount(1)
  await expect(scene.body.locator('.mermaid-block svg')).toHaveCount(0)
  const after = await position(target)
  expect(Math.abs(after.scrollTop - before.scrollTop)).toBeLessThanOrEqual(2)
  expect(Math.abs(after.targetTop - before.targetTop)).toBeLessThanOrEqual(2)
})

for (const surface of ['rich', 'preview'] as const) {
  nativeTest(
    `${surface} tab return leaves closed diagrams deferred until opened`,
    async ({ orcaPage: page, registerPostElectronShutdownCleanup }, info) => {
      await page.setViewportSize({ width: 1440, height: 900 })
      await waitForSessionReady(page)
      await waitForActiveWorktree(page)
      const context = await getActiveWorktreeContext(page)
      const filePath = await createMarkdownFixture(
        context,
        directory,
        `closed-${surface}`,
        info.workerIndex,
        `# Start\n\n<details>\n<summary>Closed diagram</summary>\n\n${diagrams[0]}\n\n</details>\n\n${prose(80)}`
      )
      const otherPath = await createMarkdownFixture(
        context,
        directory,
        `other-${surface}`,
        info.workerIndex,
        '# Other'
      )
      registerPostElectronShutdownCleanup(async () => {
        await Promise.all([cleanupMarkdownFixture(filePath), cleanupMarkdownFixture(otherPath)])
      })
      const gate = await holdMermaidRendering(page)
      try {
        await openMarkdownFixture(page, context, otherPath)
        await (surface === 'rich'
          ? openMarkdownFixture(page, context, filePath)
          : openPreview(page, context, filePath))
        const body = page.locator(
          surface === 'rich' ? '.ProseMirror' : '.markdown-preview .markdown-body'
        )
        await expect(body.locator('[data-mermaid-lazy]')).toHaveCount(1)
        await expect(body.locator('.mermaid-block svg')).toHaveCount(0)
        await page
          .locator('[data-tab-id]')
          .filter({ hasText: path.basename(otherPath) })
          .click()
        await expect(page.getByRole('heading', { name: 'Other', exact: true })).toBeVisible()
        await page
          .locator('[data-tab-id]')
          .filter({ hasText: path.basename(filePath) })
          .click()
        await expect(body.getByRole('heading', { name: 'Start', exact: true })).toBeInViewport()
        await expect(body.locator('[data-mermaid-lazy]')).toHaveCount(1)
        await page.evaluate(() => {
          const settled = Promise.withResolvers<void>()
          requestAnimationFrame(() => requestAnimationFrame(() => settled.resolve()))
          return settled.promise
        })
        expect(await gate.evaluate((value) => value.calls())).toBe(0)
        await (surface === 'rich'
          ? body.getByRole('button', { name: 'Expand details content', exact: true }).click()
          : body.locator('summary').click())
        await expect.poll(() => gate.evaluate((value) => value.calls())).toBeGreaterThan(0)
        await gate.evaluate((value) => value.release())
        await expect(body.locator('.mermaid-block svg')).toHaveCount(1)
        await expect(body.locator('.mermaid-block svg')).toContainText(alpha)
      } finally {
        await gate.evaluate((value) => value.restore()).finally(() => gate.dispose())
      }
    }
  )
}
