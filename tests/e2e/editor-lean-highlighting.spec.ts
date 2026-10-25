import { writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Locator } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import {
  cleanupGoldenWorktree,
  createGoldenWorktree,
  openGoldenSourceControl
} from './helpers/golden-source-control'
import { waitForSessionReady } from './helpers/store'

const source = [
  '-- proof note',
  'theorem identity (p : Prop) : p → p := by',
  '  intro h',
  '  exact h',
  '#check ∀ (α : Type), α → α',
  '#eval "hello"',
  '/- outer /- inner',
  '-/ still outer',
  'theorem hidden : True := by trivial',
  '-/',
  'def answer : Nat := 42',
  ''
].join('\n')

async function paintedTokens(editor: Locator) {
  return editor.locator('.view-lines:not(.line-delete)').evaluate((lines) =>
    [...lines.querySelectorAll('.view-line')].map((line) => ({
      text: (line.textContent ?? '').replaceAll('\u00a0', ' '),
      tokens: [...line.querySelectorAll('span[class*="mtk"]')].map((token) => ({
        text: (token.textContent ?? '').replaceAll('\u00a0', ' '),
        className: token.className,
        color: getComputedStyle(token).color
      }))
    }))
  )
}

async function expectHighlighted(editor: Locator): Promise<void> {
  await expect(editor).toBeVisible()
  await expect(editor.locator('.view-lines:not(.line-delete)')).toContainText('-- proof note')
  await expect
    .poll(
      async () => {
        const lines = await paintedTokens(editor)
        const color = (lineText: string, text: string) =>
          lines
            .find((line) => line.text === lineText)
            ?.tokens.find((token) => token.text.includes(text))?.color
        const keyword = color('theorem identity (p : Prop) : p → p := by', 'theorem')
        const type = color('theorem identity (p : Prop) : p → p := by', 'Prop')
        const unicode = color('#check ∀ (α : Type), α → α', '∀')
        const comment = color('-- proof note', 'proof note')
        const string = color('#eval "hello"', 'hello')
        const hidden = color('theorem hidden : True := by trivial', 'theorem')
        const resumed = color('def answer : Nat := 42', 'def')
        return (
          [keyword, type, unicode, comment, string, hidden, resumed].every(Boolean) &&
          new Set([keyword, type, comment, string]).size >= 4 &&
          hidden === comment &&
          resumed === keyword
        )
      },
      { timeout: 25_000 }
    )
    .toBe(true)
}

test('renders lean source and source-control diffs in both themes', async ({
  orcaPage,
  electronApp,
  testRepoPath,
  registerPostElectronShutdownCleanup
}, testInfo) => {
  const fixture = createGoldenWorktree(testRepoPath, 'lean-highlighting')
  registerPostElectronShutdownCleanup(async () => cleanupGoldenWorktree(testRepoPath, fixture))
  writeFileSync(path.join(fixture.worktreePath, 'Main.lean'), source)
  await waitForSessionReady(orcaPage)
  await openGoldenSourceControl(orcaPage, testRepoPath, fixture)
  const identity = await electronApp.evaluate(({ BrowserWindow }) => ({
    cwd: process.cwd(),
    windows: BrowserWindow.getAllWindows().map((window) => ({
      visible: window.isVisible(),
      focused: window.isFocused()
    }))
  }))
  expect(identity.cwd).toBe(process.cwd())
  expect(identity.windows.length).toBeGreaterThan(0)
  expect(identity.windows.every((window) => !window.visible && !window.focused)).toBe(true)
  await testInfo.attach('hidden-instance-identity', {
    body: JSON.stringify(identity, null, 2),
    contentType: 'application/json'
  })

  for (const filename of ['Main.lean']) {
    await orcaPage.evaluate(() => window.__store?.getState().showRightSidebarFiles())
    await orcaPage
      .locator('button[data-explorer-draggable="true"]')
      .filter({ has: orcaPage.getByText(filename, { exact: true }) })
      .click()
    await expect
      .poll(() => orcaPage.evaluate(() => window.__monacoEditorE2E?.filePath))
      .toBe(path.join(fixture.worktreePath, filename))
    await expect
      .poll(() => orcaPage.evaluate(() => window.__monacoEditorE2E?.snapshot().valueLength))
      .toBe(source.length)

    for (const theme of ['light', 'dark'] as const) {
      await orcaPage.evaluate(
        (theme) => window.__store?.getState().updateSettings({ theme }),
        theme
      )
      const editor = orcaPage
        .locator(theme === 'light' ? '.monaco-editor.vs' : '.monaco-editor.vs-dark')
        .first()
      await expectHighlighted(editor)
      await testInfo.attach(`${filename}-source-${theme}-tokens`, {
        body: JSON.stringify(await paintedTokens(editor), null, 2),
        contentType: 'application/json'
      })
      await orcaPage.screenshot({ path: testInfo.outputPath(`${filename}-source-${theme}.png`) })
    }

    await orcaPage.getByRole('button', { name: /Source Control/ }).click()
    await orcaPage
      .locator('[data-testid="source-control-entry"]')
      .filter({ hasText: filename })
      .click()
    for (const theme of ['light', 'dark'] as const) {
      await orcaPage.evaluate(
        (theme) => window.__store?.getState().updateSettings({ theme }),
        theme
      )
      const editor = orcaPage.locator(
        theme === 'light'
          ? '.modified-in-monaco-diff-editor.vs'
          : '.modified-in-monaco-diff-editor.vs-dark'
      )
      await expectHighlighted(editor)
      await testInfo.attach(`${filename}-diff-${theme}-tokens`, {
        body: JSON.stringify(await paintedTokens(editor), null, 2),
        contentType: 'application/json'
      })
      await orcaPage.screenshot({ path: testInfo.outputPath(`${filename}-diff-${theme}.png`) })
    }
  }
  expect(
    await electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().every((window) => !window.isVisible() && !window.isFocused())
    )
  ).toBe(true)
})
