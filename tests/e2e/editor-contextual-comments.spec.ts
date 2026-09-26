import { writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import {
  activateGoldenWorktree,
  cleanupGoldenWorktree,
  createGoldenWorktree
} from './helpers/golden-source-control'
import { waitForSessionReady } from './helpers/store'

type CommentCase = {
  fileName: string
  source: string
  selectedText: string
  expectedText: string | readonly string[]
  extendSelectionDown?: number
  forbiddenText?: readonly string[]
  selectAllMatches?: boolean
}

const COMMENT_CASES: readonly CommentCase[] = [
  {
    fileName: 'comment-test.tsx',
    source: ['const view = (', '  <section>', '    <h1>Hello</h1>', '  </section>', ')'].join('\n'),
    selectedText: '<h1>Hello</h1>',
    expectedText: '{/* <h1>Hello</h1> */}'
  },
  {
    fileName: 'comment-test.jsx',
    source: ['const view = (', '  <section>', '    <h1>Hello</h1>', '  </section>', ')'].join('\n'),
    selectedText: '<h1>Hello</h1>',
    expectedText: '{/* <h1>Hello</h1> */}'
  },
  {
    fileName: 'comment-multiline-test.tsx',
    source: [
      'const view = (',
      '  <section>',
      '    <h1>Hello</h1>',
      '    <p>World</p>',
      '  </section>',
      ')'
    ].join('\n'),
    selectedText: '<h1>Hello</h1>',
    expectedText: ['{/* <h1>Hello</h1>', '<p>World</p> */}'],
    extendSelectionDown: 1
  },
  {
    fileName: 'comment-script-test.tsx',
    source: ['const value: number = 1', 'const view = <div>{value}</div>'].join('\n'),
    selectedText: 'const value: number = 1',
    expectedText: '// const value: number = 1'
  },
  {
    fileName: 'comment-uncomment-neighbor-test.tsx',
    source: [
      'const view = (',
      '  <section>',
      '    {/* one */} <Child />',
      '  </section>',
      ')'
    ].join('\n'),
    selectedText: 'one',
    expectedText: 'one <Child />'
  },
  {
    fileName: 'comment-uncomment-pair-test.tsx',
    source: [
      'const view = (',
      '  <section>',
      '    {/* one */} {/* two */}',
      '  </section>',
      ')'
    ].join('\n'),
    selectedText: 'one',
    expectedText: 'one {/* two */}'
  },
  {
    fileName: 'comment-mixed-context-test.tsx',
    source: [
      'const MARKER = 1',
      'const view = (',
      '  <section>',
      '    MARKER',
      '  </section>',
      ')'
    ].join('\n'),
    selectedText: 'MARKER',
    expectedText: ['const MARKER = 1', 'MARKER'],
    forbiddenText: ['// const MARKER', '{/* MARKER */}'],
    selectAllMatches: true
  },
  {
    fileName: 'comment-test.ts',
    source: 'const value: number = 1',
    selectedText: 'const value: number = 1',
    expectedText: '// const value: number = 1'
  },
  {
    fileName: 'comment-test.js',
    source: 'const value = 1',
    selectedText: 'const value = 1',
    expectedText: '// const value = 1'
  },
  {
    fileName: 'comment-test.sql',
    source: 'SELECT 1;',
    selectedText: 'SELECT 1;',
    expectedText: '-- SELECT 1;'
  },
  {
    fileName: 'comment-test.py',
    source: 'value = 1',
    selectedText: 'value = 1',
    expectedText: '# value = 1'
  }
]

function getExplorerRow(page: Page, fileName: string) {
  const explorer = page.locator('[data-orca-explorer-shell]')
  return explorer.locator('[data-file-explorer-row]').filter({
    has: page.locator('[data-file-explorer-row-name]').getByText(fileName, { exact: true })
  })
}

async function selectEditorText(
  page: Page,
  selectedText: string,
  selectAllMatches = false
): Promise<void> {
  const monaco = page.locator('.monaco-editor').first()
  await monaco.click()
  await page.keyboard.press('ControlOrMeta+f')
  const findInput = monaco.locator('.find-widget .input[aria-label="Find"]')
  await expect(findInput).toBeVisible()
  await findInput.fill(selectedText)
  await page.keyboard.press(selectAllMatches ? 'Alt+Enter' : 'Enter')
  await page.keyboard.press('Escape')
}

test('uses contextual comments in JSX files and preserves Monaco comments elsewhere', async ({
  orcaPage,
  testRepoPath,
  registerPostElectronShutdownCleanup
}) => {
  const fixture = createGoldenWorktree(testRepoPath, 'contextual-comments')
  registerPostElectronShutdownCleanup(async () => cleanupGoldenWorktree(testRepoPath, fixture))
  for (const commentCase of COMMENT_CASES) {
    writeFileSync(path.join(fixture.worktreePath, commentCase.fileName), commentCase.source)
  }

  await waitForSessionReady(orcaPage)
  await activateGoldenWorktree(orcaPage, testRepoPath, fixture.worktreePath)
  await orcaPage.evaluate(() => {
    const state = window.__store?.getState()
    state?.setRightSidebarTab('explorer')
    state?.setRightSidebarOpen(true)
  })

  for (const commentCase of COMMENT_CASES) {
    await getExplorerRow(orcaPage, commentCase.fileName).click()
    await expect(orcaPage.locator('.editor-header-path').first()).toContainText(
      commentCase.fileName,
      { timeout: 20_000 }
    )
    const editorLines = orcaPage.locator('.monaco-editor').first().locator('.view-lines')
    await expect(editorLines).toContainText(commentCase.selectedText, { timeout: 25_000 })

    await selectEditorText(orcaPage, commentCase.selectedText, commentCase.selectAllMatches)
    for (let index = 0; index < (commentCase.extendSelectionDown ?? 0); index += 1) {
      await orcaPage.keyboard.press('Shift+ArrowDown')
    }
    await orcaPage.keyboard.press('ControlOrMeta+/')

    const expectedTexts =
      typeof commentCase.expectedText === 'string'
        ? [commentCase.expectedText]
        : commentCase.expectedText
    for (const expectedText of expectedTexts) {
      await expect(editorLines).toContainText(expectedText)
    }
    if (commentCase.forbiddenText) {
      await orcaPage.waitForTimeout(250)
      for (const forbiddenText of commentCase.forbiddenText) {
        await expect(editorLines).not.toContainText(forbiddenText)
      }
    }
  }
})
