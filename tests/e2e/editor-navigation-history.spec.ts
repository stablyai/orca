import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { getActiveWorktreeContext } from './helpers/markdown-editor-fixture'

async function goToLine(page: Page, line: string): Promise<void> {
  await expect(page.getByRole('textbox', { name: 'Editor content', exact: true })).toBeFocused()
  await page.keyboard.press('Control+g')
  const input = page.locator('.quick-input-widget input:visible')
  await input.fill(`:${line}`)
  await input.press('Enter')
  await expect
    .poll(() =>
      page.evaluate(() => window.__monacoEditorE2E?.snapshot().selection?.positionLineNumber)
    )
    .toBe(Number(line.split(':')[0]))
}

test('navigates across editor tabs with cursor and viewport restoration and remappable shortcuts', async ({
  orcaPage
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  const context = await getActiveWorktreeContext(orcaPage)
  for (const name of ['navigation-a.ts', 'navigation-b.ts']) {
    await writeFile(
      path.join(context.rootPath, name),
      Array.from(
        { length: 200 },
        (_, index) => `export const line${index + 1} = ${index + 1}`
      ).join('\n')
    )
    await orcaPage.evaluate(
      ({ worktreeId, rootPath, name }) => {
        window.__store?.getState().openFile({
          filePath: `${rootPath}/${name}`,
          relativePath: name,
          worktreeId,
          language: 'typescript',
          mode: 'edit'
        })
      },
      { ...context, name }
    )
    await expect(orcaPage.locator('.editor-header-path').first()).toContainText(name)
    await expect(
      orcaPage.getByRole('textbox', { name: 'Editor content', exact: true })
    ).toBeVisible()
  }

  const firstTab = orcaPage.locator('[data-tab-id]').filter({ hasText: 'navigation-a.ts' }).last()
  const secondTab = orcaPage.locator('[data-tab-id]').filter({ hasText: 'navigation-b.ts' }).last()
  await firstTab.click()
  await goToLine(orcaPage, '40:7')
  await orcaPage.evaluate(() => window.__monacoEditorE2E?.restoreScrollTop(700))
  await expect
    .poll(() => orcaPage.evaluate(() => window.__monacoEditorE2E?.snapshot().scrollTop))
    .toBe(700)
  await secondTab.click()
  await goToLine(orcaPage, '120:9')
  await orcaPage.screenshot({ path: testInfo.outputPath('before-back.png') })

  const back = process.platform === 'darwin' ? 'Meta+[' : 'Alt+ArrowLeft'
  const forward = process.platform === 'darwin' ? 'Meta+]' : 'Alt+ArrowRight'
  await orcaPage.keyboard.press(back)
  await expect(orcaPage.locator('.editor-header-path').first()).toContainText('navigation-b.ts')
  await expect
    .poll(() =>
      orcaPage.evaluate(() => window.__monacoEditorE2E?.snapshot().selection?.positionLineNumber)
    )
    .toBe(1)
  await orcaPage.keyboard.press(back)
  await expect(orcaPage.locator('.editor-header-path').first()).toContainText('navigation-a.ts')
  await expect
    .poll(() =>
      orcaPage.evaluate(() => window.__monacoEditorE2E?.snapshot().selection?.positionLineNumber)
    )
    .toBe(40)
  await expect
    .poll(() =>
      orcaPage.evaluate(() => window.__monacoEditorE2E?.snapshot().selection?.positionColumn)
    )
    .toBe(7)
  await expect
    .poll(() => orcaPage.evaluate(() => window.__monacoEditorE2E?.snapshot().scrollTop))
    .toBe(700)
  await orcaPage.screenshot({ path: testInfo.outputPath('after-back.png') })
  await orcaPage.evaluate(() => window.__monacoEditorE2E?.restoreScrollTop(600))

  await orcaPage.keyboard.press(forward)
  await expect(orcaPage.locator('.editor-header-path').first()).toContainText('navigation-b.ts')
  await expect
    .poll(() =>
      orcaPage.evaluate(() => window.__monacoEditorE2E?.snapshot().selection?.positionLineNumber)
    )
    .toBe(1)
  await expect(orcaPage.getByRole('textbox', { name: 'Editor content', exact: true })).toBeFocused()
  await orcaPage.keyboard.press(forward)
  await expect
    .poll(() =>
      orcaPage.evaluate(() => window.__monacoEditorE2E?.snapshot().selection?.positionLineNumber)
    )
    .toBe(120)

  await orcaPage.evaluate(() => {
    window.__store?.setState({ keybindings: { 'editor.navigateBack': ['Mod+Shift+F9'] } })
  })
  await orcaPage.keyboard.press(back)
  await expect
    .poll(() =>
      orcaPage.evaluate(() => window.__monacoEditorE2E?.snapshot().selection?.positionLineNumber)
    )
    .toBe(120)
  await orcaPage.keyboard.press('ControlOrMeta+Shift+F9')
  await expect
    .poll(() =>
      orcaPage.evaluate(() => window.__monacoEditorE2E?.snapshot().selection?.positionLineNumber)
    )
    .toBe(1)
  await orcaPage.keyboard.press('ControlOrMeta+Shift+F9')
  await expect(orcaPage.locator('.editor-header-path').first()).toContainText('navigation-a.ts')
  await expect
    .poll(() => orcaPage.evaluate(() => window.__monacoEditorE2E?.snapshot().scrollTop))
    .toBe(600)

  await secondTab.click()
  await expect(orcaPage.getByRole('textbox', { name: 'Editor content', exact: true })).toBeFocused()
  await firstTab.getByRole('button', { name: 'Close tab', exact: true }).click()
  await orcaPage.getByRole('textbox', { name: 'Editor content', exact: true }).focus()
  await orcaPage.keyboard.press('ControlOrMeta+Shift+F9')
  await expect(orcaPage.locator('.editor-header-path').first()).toContainText('navigation-a.ts')
  await expect
    .poll(() =>
      orcaPage.evaluate(() => window.__monacoEditorE2E?.snapshot().selection?.positionLineNumber)
    )
    .toBe(40)
  await expect
    .poll(() => orcaPage.evaluate(() => window.__monacoEditorE2E?.snapshot().scrollTop))
    .toBe(600)
})
