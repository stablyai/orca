import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import {
  activateGoldenWorktree,
  cleanupGoldenWorktree,
  createGoldenWorktree,
  GOLDEN_CHANGED_PATH
} from './helpers/golden-source-control'
import { clickFileInExplorer, openFileExplorer } from './helpers/file-explorer'
import { waitForSessionReady } from './helpers/store'
import { forwardRendererConsole } from './helpers/renderer-console-forwarding'

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

test('@golden emacs keybindings drive the Monaco file editor', async ({
  orcaPage,
  testRepoPath,
  registerPostElectronShutdownCleanup
}, testInfo) => {
  forwardRendererConsole(orcaPage, testInfo)
  const fixture = createGoldenWorktree(testRepoPath, 'emacs-keybindings')
  registerPostElectronShutdownCleanup(async () => cleanupGoldenWorktree(testRepoPath, fixture))
  const indexPath = path.join(fixture.worktreePath, GOLDEN_CHANGED_PATH)

  await waitForSessionReady(orcaPage)

  // Autosave stays off so every write goes through `C-x C-s`.
  await orcaPage.evaluate(() =>
    window.__store?.getState().updateSettings({
      editorKeybindings: 'emacs',
      editorAutoSave: false
    })
  )
  await expect
    .poll(() => orcaPage.evaluate(() => window.__store?.getState().settings?.editorKeybindings))
    .toBe('emacs')

  await activateGoldenWorktree(orcaPage, testRepoPath, fixture.worktreePath)
  await openFileExplorer(orcaPage)
  const opened = await clickFileInExplorer(orcaPage, [GOLDEN_CHANGED_PATH])
  expect(opened).toBe(GOLDEN_CHANGED_PATH)

  // Other empty Monaco instances would shadow a bare `.monaco-editor` selector.
  const fileEditor = orcaPage.locator('[data-orca-file-editor]').first()
  const monaco = fileEditor.locator('.monaco-editor').first()
  await expect(monaco).toBeVisible({ timeout: 25_000 })
  const viewLines = monaco.locator('.view-lines')
  await expect(viewLines).toContainText('export const hello', { timeout: 20_000 })

  const statusBar = fileEditor.locator('[data-orca-emacs-statusbar]')
  await expect(statusBar).toBeAttached()

  // The block caret proves the lazy import resolved and attached.
  await expect(monaco.locator('.cursors-layer.cursor-block-style')).toBeAttached({
    timeout: 10_000
  })

  await monaco.click()
  const kb = orcaPage.keyboard
  const save = async (): Promise<void> => {
    // Control stays held across both keys, the way the chord is usually typed.
    await kb.down('Control')
    await kb.press('x')
    await kb.press('s')
    await kb.up('Control')
    await expect(monaco.locator('.find-widget.visible')).toHaveCount(0)
  }

  await kb.press('Control+x')
  await expect(statusBar).toContainText('C-x', { timeout: 5_000 })
  await kb.press('Control+g')
  await expect(statusBar).toHaveText('', { timeout: 5_000 })

  // The click lands on the trailing empty line.
  await kb.press('ArrowUp')
  await kb.press('Control+a')
  await kb.press('Control+Space')
  await expect(statusBar).toContainText('Mark set', { timeout: 5_000 })
  await kb.press('Control+e')
  await kb.press('Alt+w')
  await expect(statusBar).not.toContainText('Mark set', { timeout: 5_000 })
  await kb.press('Enter')
  await kb.press('Control+y')
  expect(countOccurrences(readFileSync(indexPath, 'utf8'), 'export const hello = "world"')).toBe(1)
  await save()
  await expect
    .poll(() => countOccurrences(readFileSync(indexPath, 'utf8'), 'export const hello = "world"'), {
      timeout: 10_000
    })
    .toBe(2)

  await kb.press('Control+a')
  await kb.press('Control+k')
  await save()
  await expect
    .poll(() => countOccurrences(readFileSync(indexPath, 'utf8'), 'export const hello = "world"'), {
      timeout: 10_000
    })
    .toBe(1)
  await kb.press('Control+y')
  await save()
  await expect
    .poll(() => countOccurrences(readFileSync(indexPath, 'utf8'), 'export const hello = "world"'), {
      timeout: 10_000
    })
    .toBe(2)

  // Upstream binds Tab to formatDocument.
  await kb.press('Control+a')
  await kb.press('Tab')
  await save()
  await expect
    .poll(() => readFileSync(indexPath, 'utf8'), { timeout: 10_000 })
    .toMatch(/^\s+export const hello = "world"/m)
})
