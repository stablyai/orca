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
  '// proof note',
  'const std = @import("std");',
  'pub fn main() void {',
  '    const answer: u32 = 42;',
  '    std.debug.print("hello {d}\\n", .{answer});',
  '}',
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
  await expect(editor.locator('.view-lines:not(.line-delete)')).toContainText('// proof note')
  await expect
    .poll(
      async () => {
        const lines = await paintedTokens(editor)
        const color = (lineText: string, text: string) =>
          lines
            .find((line) => line.text === lineText)
            ?.tokens.find((token) => token.text.includes(text))?.color
        const keyword = color('pub fn main() void {', 'pub')
        const type = color('    const answer: u32 = 42;', 'u32')
        const number = color('    const answer: u32 = 42;', '42')
        const comment = color('// proof note', 'proof note')
        const string = color('    std.debug.print("hello {d}\\n", .{answer});', 'hello')
        return (
          [keyword, type, number, comment, string].every(Boolean) &&
          new Set([keyword, type, number, comment, string]).size >= 4
        )
      },
      { timeout: 25_000 }
    )
    .toBe(true)
}

test('renders Zig source and source-control diffs in both themes', async ({
  orcaPage,
  electronApp,
  testRepoPath,
  registerPostElectronShutdownCleanup
}, testInfo) => {
  const fixture = createGoldenWorktree(testRepoPath, 'zig-highlighting')
  registerPostElectronShutdownCleanup(async () => cleanupGoldenWorktree(testRepoPath, fixture))
  writeFileSync(path.join(fixture.worktreePath, 'main.zig'), source)
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

  for (const filename of ['main.zig']) {
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
