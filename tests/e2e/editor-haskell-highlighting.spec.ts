import { writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Locator } from '@stablyai/playwright-test'
import { detectLanguage } from '../../src/renderer/src/lib/language-detect'
import { test, expect } from './helpers/orca-app'
import {
  cleanupGoldenWorktree,
  createGoldenWorktree,
  openGoldenSourceControl
} from './helpers/golden-source-control'
import { waitForSessionReady } from './helpers/store'

const source = [
  'module Main where',
  '-- A comment',
  'answer :: Int',
  'answer = 42',
  'main = putStrLn "hello"',
  ''
].join('\n')

async function colors(editor: Locator): Promise<Record<string, string | null>> {
  return editor.locator('.view-lines:not(.line-delete)').evaluate((lines) => {
    const colorOf = (text: string) => {
      const span = [...lines.querySelectorAll('span[class*="mtk"]')].find((entry) =>
        entry.textContent?.includes(text)
      )
      return span ? getComputedStyle(span).color : null
    }
    return {
      keyword: colorOf('module'),
      comment: colorOf('comment'),
      type: colorOf('Int'),
      number: colorOf('42'),
      string: colorOf('hello')
    }
  })
}

async function expectHighlighted(editor: Locator): Promise<void> {
  await expect(editor.locator('.view-lines:not(.line-delete)')).toContainText('module Main where')
  await expect
    .poll(
      async () => {
        const painted = await colors(editor)
        return (
          Object.values(painted).every((color) => color !== null) &&
          new Set(Object.values(painted)).size >= 4
        )
      },
      { timeout: 25_000 }
    )
    .toBe(true)
}

test('highlights recognized Haskell source and an untracked file diff', async ({
  orcaPage,
  testRepoPath,
  registerPostElectronShutdownCleanup
}, testInfo) => {
  const fixture = createGoldenWorktree(testRepoPath, 'haskell-highlighting')
  registerPostElectronShutdownCleanup(async () => cleanupGoldenWorktree(testRepoPath, fixture))
  const filePath = path.join(fixture.worktreePath, 'Main.hs')
  writeFileSync(filePath, source)

  await waitForSessionReady(orcaPage)
  await openGoldenSourceControl(orcaPage, testRepoPath, fixture)
  await orcaPage.evaluate(
    ({ filePath, language }) => {
      const store = window.__store
      const worktreeId = store?.getState().activeWorktreeId
      if (!store || !worktreeId) {
        throw new Error('Haskell fixture worktree unavailable')
      }
      store
        .getState()
        .openFile({ filePath, relativePath: 'Main.hs', worktreeId, language, mode: 'edit' })
    },
    { filePath, language: detectLanguage(filePath) }
  )
  const sourceEditor = orcaPage.locator('.monaco-editor').first()
  await expectHighlighted(sourceEditor)
  await expect
    .poll(() => orcaPage.evaluate(() => window.__monacoEditorE2E?.snapshot().valueLength))
    .toBe(source.length)
  await orcaPage.screenshot({ path: testInfo.outputPath('haskell-source.png') })

  await orcaPage
    .locator('[data-testid="source-control-entry"]')
    .filter({ hasText: 'Main.hs' })
    .click()
  await expectHighlighted(orcaPage.locator('.modified-in-monaco-diff-editor'))
  await orcaPage.screenshot({ path: testInfo.outputPath('haskell-diff.png') })

  await orcaPage.evaluate(() => window.__store?.getState().updateSettings({ theme: 'dark' }))
  const darkDiff = orcaPage.locator('.modified-in-monaco-diff-editor.vs-dark')
  await expectHighlighted(darkDiff)
  await orcaPage.screenshot({ path: testInfo.outputPath('haskell-diff-dark.png') })
})
