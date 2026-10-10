import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
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

const WIDE_LINE =
  'const veryLongLineOfCodeThatShouldNotWrapAtAllUnderAnyCircumstances = ' + `"${'a'.repeat(160)}"`
const PROSE = 'Surrounding prose still wraps into ordinary paragraphs. '.repeat(16).trim()
const WIDE_CODE_BLOCK_MARKDOWN = `# Wide code block\n\n${PROSE}\n\n\`\`\`ts\n${WIDE_LINE}\n\`\`\`\n`

test.describe('Wide code blocks scroll horizontally', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await orcaPage.setViewportSize({ width: 1440, height: 900 })
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
  })

  for (const kind of ['git', 'folder'] as const) {
    test(`wide code scrolls and saves without changing prose wrapping in a ${kind} workspace`, async ({
      orcaPage,
      registerPostElectronShutdownCleanup
    }, testInfo) => {
      let filePath: string | null = null

      try {
        const folderPath =
          kind === 'folder' ? mkdtempSync(path.join(os.tmpdir(), 'orca-wide-code-')) : null
        if (folderPath) {
          registerPostElectronShutdownCleanup(async () =>
            rmSync(folderPath, { recursive: true, force: true })
          )
          await orcaPage.evaluate(async (folderPath) => {
            const state = window.__store?.getState()
            if (!state) {
              throw new Error('Missing fixture store')
            }
            const group = await window.api.projectGroups.create({
              name: 'Wide code fixture',
              parentPath: folderPath,
              createdFrom: 'folder-scan'
            })
            await state.fetchProjectGroups()
            const folder = await state.createFolderWorkspace({
              projectGroupId: group.id,
              name: 'Wide code document',
              folderPath
            })
            if (!folder) {
              throw new Error('Missing fixture folder')
            }
            state.setActiveWorktree(`folder:${folder.id}`)
          }, folderPath)
        }
        const context = folderPath
          ? await orcaPage.evaluate((rootPath) => {
              const worktreeId = window.__store?.getState().activeWorktreeId
              if (!worktreeId) {
                throw new Error('Missing folder workspace')
              }
              return { worktreeId, rootPath }
            }, folderPath)
          : await getActiveWorktreeContext(orcaPage)
        filePath = await createMarkdownFixture(
          context,
          '.orca-e2e-wide-code',
          'code-block-horizontal-scroll',
          testInfo.workerIndex,
          WIDE_CODE_BLOCK_MARKDOWN
        )
        await openMarkdownFixture(orcaPage, context, filePath)
        const editor = await waitForRichMarkdownEditor(orcaPage)
        const pre = editor.locator('pre')
        await expect(pre).toHaveText(WIDE_LINE)

        const metrics = await orcaPage.evaluate(() => {
          const pre = document.querySelector('.rich-markdown-editor pre')
          if (!pre) {
            throw new Error('Code block was not rendered')
          }
          return {
            whiteSpace: window.getComputedStyle(pre).whiteSpace,
            scrollWidth: pre.scrollWidth,
            clientWidth: pre.clientWidth,
            contentHeight:
              pre.scrollHeight -
              Number.parseFloat(getComputedStyle(pre).paddingTop) -
              Number.parseFloat(getComputedStyle(pre).paddingBottom),
            lineHeight: Number.parseFloat(getComputedStyle(pre).lineHeight)
          }
        })

        // The wide viewport fits WIDE_LINE's unbroken run on one wrapped
        // line under pre-wrap with no overflow, so scrollWidth exceeds
        // clientWidth only once white-space: pre removes that wrap point.
        expect(metrics.whiteSpace).toBe('pre')
        expect(metrics.scrollWidth).toBeGreaterThan(metrics.clientWidth)
        expect(metrics.contentHeight).toBeLessThanOrEqual(metrics.lineHeight + 1)
        const prose = editor.locator('p').filter({ hasText: 'Surrounding prose' })
        const proseMetrics = await prose.evaluate((paragraph) => ({
          height: paragraph.getBoundingClientRect().height,
          lineHeight: Number.parseFloat(getComputedStyle(paragraph).lineHeight),
          scrollWidth: paragraph.scrollWidth,
          clientWidth: paragraph.clientWidth
        }))
        expect(proseMetrics.height).toBeGreaterThan(proseMetrics.lineHeight * 1.5)
        expect(proseMetrics.scrollWidth).toBeLessThanOrEqual(proseMetrics.clientWidth + 1)
        await pre.hover()
        await orcaPage.mouse.wheel(400, 0)
        await expect.poll(() => pre.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0)
        await expect(editor.getByRole('button', { name: 'Copy code', exact: true })).toBeVisible()
        await editor.focus()
        await pre.evaluate((element) => {
          const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
          let last = walker.nextNode()
          for (let next = walker.nextNode(); next; next = walker.nextNode()) {
            last = next
          }
          if (!(last instanceof Text)) {
            throw new Error('Missing code text')
          }
          const range = document.createRange()
          range.setStart(last, last.length)
          range.collapse(true)
          const selection = document.getSelection()
          selection?.removeAllRanges()
          selection?.addRange(range)
          document.dispatchEvent(new Event('selectionchange'))
        })
        await editor.pressSequentially(' edited')
        await expect(pre).toHaveText(`${WIDE_LINE} edited`)
        const isMac = await orcaPage.evaluate(() => navigator.userAgent.includes('Mac'))
        await editor.press(`${isMac ? 'Meta' : 'Control'}+s`)
        const savedPath = filePath
        await expect.poll(() => readFileSync(savedPath, 'utf8')).toContain(`${WIDE_LINE} edited\n`)
        expect(readFileSync(savedPath, 'utf8')).toContain(PROSE)
        await orcaPage.screenshot({
          path: testInfo.outputPath(`wide-code-${kind}.png`),
          animations: 'disabled'
        })
        const metricsPath = testInfo.outputPath('wide-code-metrics.json')
        writeFileSync(
          metricsPath,
          JSON.stringify(
            { kind, metrics, proseMetrics, savedMarkdown: readFileSync(savedPath, 'utf8') },
            null,
            2
          )
        )
        await testInfo.attach('wide-code-metrics', {
          path: metricsPath,
          contentType: 'application/json'
        })
        await orcaPage.setViewportSize({ width: 900, height: 700 })
        await expect
          .poll(() => pre.evaluate((element) => element.scrollWidth > element.clientWidth))
          .toBe(true)
        await orcaPage.evaluate(
          ({ filePath, relativePath, worktreeId }) => {
            window.__store
              ?.getState()
              .openMarkdownPreview({ filePath, relativePath, worktreeId, language: 'markdown' })
          },
          {
            filePath,
            relativePath: path.relative(context.rootPath, filePath),
            worktreeId: context.worktreeId
          }
        )
        const preview = orcaPage.locator('.markdown-body pre')
        await expect(preview).toHaveText(`${WIDE_LINE} edited`)
        await expect
          .poll(() => preview.evaluate((element) => element.scrollWidth > element.clientWidth))
          .toBe(true)
      } finally {
        await cleanupMarkdownFixture(filePath)
      }
    })
  }
})
