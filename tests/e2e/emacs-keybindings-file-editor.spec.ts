import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { ElectronApplication } from '@stablyai/playwright-test'
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

// Why: Playwright's keyboard dispatches straight into the renderer and never reaches Electron's
// before-input-event, where Orca resolves app shortcuts such as quick open. A native input event
// walks the whole path: main-process allowlist → renderer handlers → Monaco.
async function pressNativeControlChord(app: ElectronApplication, keyCode: string): Promise<void> {
  await app.evaluate(({ BrowserWindow }, code) => {
    const target = BrowserWindow.getAllWindows()[0]
    target?.webContents.sendInputEvent({ type: 'keyDown', keyCode: code, modifiers: ['control'] })
    target?.webContents.sendInputEvent({ type: 'keyUp', keyCode: code, modifiers: ['control'] })
  }, keyCode)
}

// Exercises the real monaco-emacs adapter against the live Monaco file editor: line movement,
// the kill ring (C-k / C-y), mark + region copy (C-SPC / M-w), the C-x prefix echo, and C-g.
// It also proves the editor keybinding context: an Orca chord that collides with an Emacs chord
// (Ctrl+P, bound to quick open here the way it is by default on Linux/Windows) reaches the editor
// while it has focus and still opens quick open everywhere else. Autosave stays off: every write
// below goes through `C-x C-s`, since with the Emacs preset Ctrl+S is incremental search.
test('@golden emacs keybindings drive the Monaco file editor', async ({
  electronApp,
  orcaPage,
  testRepoPath,
  registerPostElectronShutdownCleanup
}, testInfo) => {
  forwardRendererConsole(orcaPage, testInfo)
  const fixture = createGoldenWorktree(testRepoPath, 'emacs-keybindings')
  registerPostElectronShutdownCleanup(async () => cleanupGoldenWorktree(testRepoPath, fixture))
  const indexPath = path.join(fixture.worktreePath, GOLDEN_CHANGED_PATH)

  await waitForSessionReady(orcaPage)

  // Enable the Emacs preset before the editor mounts.
  await orcaPage.evaluate(() =>
    window.__store?.getState().updateSettings({ editorKeybindings: 'emacs', editorAutoSave: false })
  )
  await expect
    .poll(() => orcaPage.evaluate(() => window.__store?.getState().settings?.editorKeybindings))
    .toBe('emacs')
  // Why: macOS binds quick open to Cmd+P, so the Ctrl+P collision only exists after this override.
  await orcaPage.evaluate(() =>
    window.__store?.getState().setKeybindingOverride('worktree.quickOpen', ['Ctrl+P'])
  )
  await expect
    .poll(() =>
      orcaPage.evaluate(() => window.__store?.getState().keybindings['worktree.quickOpen'])
    )
    .toEqual(['Ctrl+P'])

  await activateGoldenWorktree(orcaPage, testRepoPath, fixture.worktreePath)
  await openFileExplorer(orcaPage)
  const opened = await clickFileInExplorer(orcaPage, [GOLDEN_CHANGED_PATH])
  expect(opened).toBe(GOLDEN_CHANGED_PATH)

  // Scope to the real file editor; the app mounts other (empty) Monaco instances whose
  // `.view-lines` would shadow a bare `.monaco-editor` selector.
  const fileEditor = orcaPage.locator('[data-orca-file-editor]').first()
  const monaco = fileEditor.locator('.monaco-editor').first()
  await expect(monaco).toBeVisible({ timeout: 25_000 })
  const viewLines = monaco.locator('.view-lines')
  await expect(viewLines).toContainText('export const hello', { timeout: 20_000 })

  // The status row renders for Emacs, without the Vim cheatsheet. The echo node itself is empty
  // (so zero-height) until a prefix key or the mark gives it something to say.
  const statusBar = fileEditor.locator('[data-orca-emacs-statusbar]')
  await expect(statusBar).toBeAttached()
  await expect(fileEditor.locator('[data-orca-vim-statusbar]')).toHaveCount(0)
  await expect(fileEditor.getByRole('button', { name: 'Vim commands' })).toHaveCount(0)

  // monaco-emacs switches the caret to a block on start, which is the cheapest proof the lazy
  // import resolved and the extension attached to this editor.
  await expect(monaco.locator('.cursors-layer.cursor-block-style')).toBeAttached({
    timeout: 10_000
  })

  await monaco.click()
  const kb = orcaPage.keyboard

  // Prefix echo: a pending C-x shows in the status row and C-g cancels it without editing.
  await kb.press('Control+x')
  await expect(statusBar).toContainText('C-x', { timeout: 5_000 })
  await kb.press('Control+g')
  await expect(statusBar).toHaveText('', { timeout: 5_000 })

  // Mark + region copy, then yank: C-SPC sets the mark (echoed in the status row), C-e extends the
  // region to end of line, M-w copies it and deactivates the mark, C-y pastes it on a new line.
  // The click lands on the trailing empty line, so C-p first moves onto the only line of text.
  // Ctrl+P is also Orca's quick-open chord: with the editor focused it must stay an Emacs key, so
  // it is sent natively to pass through the main-process router. If Orca consumed it, no line would
  // be copied below and the yank count would stay at 1.
  await pressNativeControlChord(electronApp, 'p')
  await kb.press('Control+a')
  await kb.press('Control+Space')
  await expect(statusBar).toContainText('Mark set', { timeout: 5_000 })
  expect(await orcaPage.evaluate(() => window.__store?.getState().activeModal)).not.toBe(
    'quick-open'
  )
  await kb.press('Control+e')
  await kb.press('Alt+w')
  await expect(statusBar).not.toContainText('Mark set', { timeout: 5_000 })
  await kb.press('Enter')
  await kb.press('Control+y')
  await expect(viewLines).toContainText('export const hello = "world"export const hello', {
    timeout: 5_000
  })
  // Nothing is on disk until C-x C-s routes through Orca's save.
  expect(countOccurrences(readFileSync(indexPath, 'utf8'), 'export const hello = "world"')).toBe(1)
  const saveWithEmacs = async (): Promise<void> => {
    await kb.press('Control+x')
    await expect(statusBar).toContainText('C-x', { timeout: 5_000 })
    await kb.press('Control+s')
  }
  await saveWithEmacs()
  await expect
    .poll(() => countOccurrences(readFileSync(indexPath, 'utf8'), 'export const hello = "world"'), {
      timeout: 10_000
    })
    .toBe(2)

  // Incremental search: C-s opens the find widget seeded by the current word; inside the widget
  // C-s / C-r step through matches and C-g closes it, handing focus back to the editor.
  const findWidget = monaco.locator('.find-widget.visible')
  const matchesCount = findWidget.locator('.matchesCount')
  await kb.press('Control+a')
  await kb.press('Control+s')
  await expect(findWidget).toBeVisible({ timeout: 5_000 })
  await findWidget.locator('textarea').first().fill('hello')
  // The caret sits on line 2, so the first match is the second occurrence; C-s wraps to the first.
  await expect(matchesCount).toHaveText('2 of 2', { timeout: 5_000 })
  await kb.press('Control+s')
  await expect(matchesCount).toHaveText('1 of 2', { timeout: 5_000 })
  await kb.press('Control+r')
  await expect(matchesCount).toHaveText('2 of 2', { timeout: 5_000 })
  await kb.press('Control+g')
  await expect(findWidget).toHaveCount(0, { timeout: 5_000 })
  await expect
    .poll(
      () =>
        orcaPage.evaluate(
          () =>
            document.activeElement?.closest('[data-orca-file-editor] .monaco-editor') !== null &&
            document.activeElement?.closest('.find-widget') === null
        ),
      { timeout: 5_000 }
    )
    .toBe(true)

  // Kill ring: C-a then C-k kills the current line's text; C-y brings it back.
  await kb.press('Control+a')
  await kb.press('Control+k')
  await saveWithEmacs()
  await expect
    .poll(() => countOccurrences(readFileSync(indexPath, 'utf8'), 'export const hello = "world"'), {
      timeout: 10_000
    })
    .toBe(1)
  await kb.press('Control+y')
  await saveWithEmacs()
  await expect
    .poll(() => countOccurrences(readFileSync(indexPath, 'utf8'), 'export const hello = "world"'), {
      timeout: 10_000
    })
    .toBe(2)

  // Plain Tab indents instead of running formatDocument (monaco-emacs's upstream default).
  await kb.press('Control+a')
  await kb.press('Tab')
  await saveWithEmacs()
  await expect
    .poll(() => readFileSync(indexPath, 'utf8'), { timeout: 10_000 })
    .toMatch(/^\s+export const hello = "world"/m)

  // Emacs windows are Orca split groups: `C-x 3` shows the file in a second group and moves point
  // there, `C-x o` walks between them, `C-x 0` closes that view and leaves the first one.
  const editorViewIds = (): Promise<(string | null)[]> =>
    orcaPage.evaluate(() =>
      [...document.querySelectorAll('[data-orca-file-editor][data-orca-editor-view]')].map((el) =>
        el.getAttribute('data-orca-editor-view')
      )
    )
  const focusedViewId = (): Promise<string | null> =>
    orcaPage.evaluate(
      () =>
        document.activeElement
          ?.closest('[data-orca-editor-view]')
          ?.getAttribute('data-orca-editor-view') ?? null
    )
  // Each view has its own echo area; the prefix shows in whichever view holds point.
  const pendingPrefix = orcaPage.locator('[data-orca-emacs-statusbar]').filter({ hasText: 'C-x' })
  const pressWindowCommand = async (key: string): Promise<void> => {
    await kb.press('Control+x')
    await expect(pendingPrefix).toHaveCount(1, { timeout: 5_000 })
    await kb.press(key)
  }
  const firstView = await focusedViewId()
  expect(firstView).not.toBeNull()
  await pressWindowCommand('3')
  await expect.poll(editorViewIds, { timeout: 10_000 }).toHaveLength(2)
  await expect.poll(focusedViewId, { timeout: 10_000 }).not.toBe(firstView)
  const secondView = await focusedViewId()
  expect(secondView).not.toBeNull()
  await pressWindowCommand('o')
  await expect.poll(focusedViewId, { timeout: 5_000 }).toBe(firstView)
  await pressWindowCommand('o')
  await expect.poll(focusedViewId, { timeout: 5_000 }).toBe(secondView)
  await pressWindowCommand('0')
  await expect.poll(editorViewIds, { timeout: 10_000 }).toEqual([firstView])
  // The surviving view takes the keyboard back before the app-focus check below.
  await orcaPage.locator('[data-orca-file-editor] .view-lines').click()
  await expect.poll(focusedViewId, { timeout: 5_000 }).toBe(firstView)

  // Outside the editor the same chord is Orca's again: quick open opens from app focus.
  await orcaPage.evaluate(() => {
    const active = document.activeElement
    if (active instanceof HTMLElement) {
      active.blur()
    }
  })
  await pressNativeControlChord(electronApp, 'p')
  await expect
    .poll(() => orcaPage.evaluate(() => window.__store?.getState().activeModal), {
      timeout: 5_000
    })
    .toBe('quick-open')
  await kb.press('Escape')
})
