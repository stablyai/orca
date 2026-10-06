import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { Locator, Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import {
  activateGoldenWorktree,
  cleanupGoldenWorktree,
  createGoldenWorktree,
  GOLDEN_CHANGED_PATH
} from './helpers/golden-source-control'
import { clickFileInExplorer, openFileExplorer } from './helpers/file-explorer'
import { waitForSessionReady } from './helpers/store'

// Exercises the real monaco-vim adapter against the live Monaco file editor: mode switching,
// a normal-mode operator (dd), insert-mode entry (o), and the :w Ex command wired to save.
test('@golden vim keybindings drive the Monaco file editor and :w saves to disk', async ({
  orcaPage,
  testRepoPath,
  registerPostElectronShutdownCleanup
}) => {
  const fixture = createGoldenWorktree(testRepoPath, 'vim-keybindings')
  registerPostElectronShutdownCleanup(async () => cleanupGoldenWorktree(testRepoPath, fixture))
  const indexPath = path.join(fixture.worktreePath, GOLDEN_CHANGED_PATH)

  await waitForSessionReady(orcaPage)

  // Enable the Vim preset before the editor mounts so the adapter installs on mount.
  await orcaPage.evaluate(() =>
    window.__store?.getState().updateSettings({ editorKeybindings: 'vim' })
  )
  await expect
    .poll(() => orcaPage.evaluate(() => window.__store?.getState().settings?.editorKeybindings))
    .toBe('vim')

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

  // The status bar row only renders when the Vim preset is active.
  const vimStatusBar = fileEditor.locator('[data-orca-vim-statusbar]')
  await expect(vimStatusBar).toBeVisible()

  await monaco.click()

  // NORMAL -> INSERT: pressing `i` must flip the adapter into insert mode.
  await orcaPage.keyboard.press('i')
  await expect(vimStatusBar).toContainText('INSERT', { timeout: 5_000 })
  // INSERT -> NORMAL.
  await orcaPage.keyboard.press('Escape')
  await expect(vimStatusBar).not.toContainText('INSERT', { timeout: 5_000 })

  // `o` opens a line below in insert mode; type a sentinel, then leave insert.
  await orcaPage.keyboard.press('g')
  await orcaPage.keyboard.press('g')
  await orcaPage.keyboard.press('o')
  await expect(vimStatusBar).toContainText('INSERT', { timeout: 5_000 })
  await orcaPage.keyboard.type('const vimWasHere = 42')
  await orcaPage.keyboard.press('Escape')
  await expect(viewLines).toContainText('const vimWasHere = 42', { timeout: 5_000 })

  // `dd` deletes the current line (the one just added), proving a normal-mode operator works.
  await orcaPage.keyboard.press('d')
  await orcaPage.keyboard.press('d')
  await expect(viewLines).not.toContainText('const vimWasHere = 42', { timeout: 5_000 })

  // Add a durable line, then `:w` must route through the focused editor to Orca's save.
  await orcaPage.keyboard.press('o')
  await orcaPage.keyboard.type('export const savedByVimWrite = true')
  await orcaPage.keyboard.press('Escape')
  await orcaPage.keyboard.type(':w')
  await orcaPage.keyboard.press('Enter')

  await expect
    .poll(() => readFileSync(indexPath, 'utf8'), { timeout: 10_000 })
    .toContain('export const savedByVimWrite = true')

  // The cheatsheet hint opens from the status bar and lists supported commands.
  await fileEditor.getByRole('button', { name: 'Vim commands' }).click()
  await expect(orcaPage.getByText('Vim command reference')).toBeVisible({ timeout: 5_000 })
  await expect(orcaPage.getByText('Delete line / word')).toBeVisible()
})

type VimEditorFixtures = {
  orcaPage: Page
  testRepoPath: string
  registerPostElectronShutdownCleanup: (cleanup: () => Promise<void>) => void
}
type VimEditorHandles = { indexPath: string; monaco: Locator; viewLines: Locator }

/** Open src/index.ts in a focused Vim-mode Monaco editor and return its locators. */
async function openVimEditor(
  { orcaPage, testRepoPath, registerPostElectronShutdownCleanup }: VimEditorFixtures,
  label: string
): Promise<VimEditorHandles> {
  const fixture = createGoldenWorktree(testRepoPath, label)
  registerPostElectronShutdownCleanup(async () => cleanupGoldenWorktree(testRepoPath, fixture))
  await waitForSessionReady(orcaPage)
  await orcaPage.evaluate(() =>
    window.__store?.getState().updateSettings({ editorKeybindings: 'vim' })
  )
  await activateGoldenWorktree(orcaPage, testRepoPath, fixture.worktreePath)
  await openFileExplorer(orcaPage)
  await clickFileInExplorer(orcaPage, [GOLDEN_CHANGED_PATH])
  const fileEditor = orcaPage.locator('[data-orca-file-editor]').first()
  const monaco = fileEditor.locator('.monaco-editor').first()
  await expect(monaco).toBeVisible({ timeout: 25_000 })
  const viewLines = monaco.locator('.view-lines')
  await expect(viewLines).toContainText('export const hello', { timeout: 20_000 })
  await monaco.click()
  return { indexPath: path.join(fixture.worktreePath, GOLDEN_CHANGED_PATH), monaco, viewLines }
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

// Proves registers (yank/paste), the :%s Ex substitution, and visual-mode selection all work —
// features monaco-vim supports but the preset's docs under-claimed.
test('@golden vim yank/paste, :%s substitution, and visual mode work in the editor', async ({
  orcaPage,
  testRepoPath,
  registerPostElectronShutdownCleanup
}) => {
  const { indexPath, viewLines } = await openVimEditor(
    { orcaPage, testRepoPath, registerPostElectronShutdownCleanup },
    'vim-registers'
  )
  const kb = orcaPage.keyboard

  // Seed a distinct line at the top: `gg` then `O` (open above) in insert mode.
  await kb.press('g')
  await kb.press('g')
  await kb.press('O')
  await kb.type('const DUP = 1')
  await kb.press('Escape')

  // yank line (`yy`) then paste below (`p`) -> the line exists twice.
  await kb.press('y')
  await kb.press('y')
  await kb.press('p')
  await kb.type(':w')
  await kb.press('Enter')
  await expect
    .poll(() => countOccurrences(readFileSync(indexPath, 'utf8'), 'const DUP = 1'), {
      timeout: 10_000
    })
    .toBe(2)

  // `:%s/DUP/REPLACED/g` substitutes across the whole buffer (both copies).
  await kb.type(':%s/DUP/REPLACED/g')
  await kb.press('Enter')
  await kb.type(':w')
  await kb.press('Enter')
  await expect
    .poll(() => readFileSync(indexPath, 'utf8'), { timeout: 10_000 })
    .not.toContain('const DUP = 1')
  await expect
    .poll(() => countOccurrences(readFileSync(indexPath, 'utf8'), 'const REPLACED = 1'))
    .toBe(2)

  // Character visual selection + delete: `0 v $ d` wipes the line's text.
  await kb.press('g')
  await kb.press('g')
  await kb.press('0')
  await kb.press('v')
  await kb.type('$')
  await kb.press('d')
  await expect(viewLines).toContainText('REPLACED', { timeout: 5_000 })
  await kb.type(':w')
  await kb.press('Enter')
  await expect
    .poll(() => countOccurrences(readFileSync(indexPath, 'utf8'), 'const REPLACED = 1'), {
      timeout: 10_000
    })
    .toBe(1)
})

// Proves macro record (`qa` … `q`) and replay (`@a`) work end to end.
test('@golden vim macros record and replay', async ({
  orcaPage,
  testRepoPath,
  registerPostElectronShutdownCleanup
}) => {
  const { indexPath } = await openVimEditor(
    { orcaPage, testRepoPath, registerPostElectronShutdownCleanup },
    'vim-macros'
  )
  const kb = orcaPage.keyboard

  // Record macro `a`: open a line and type a marker, then stop recording.
  await kb.press('g')
  await kb.press('g')
  await kb.press('q')
  await kb.press('a')
  await kb.press('o')
  await kb.type('const MAC = 9')
  await kb.press('Escape')
  await kb.press('q')

  // Replay it twice with `@a` -> three marker lines total (1 recorded + 2 replayed).
  await kb.type('@a')
  await kb.type('@a')
  await kb.type(':w')
  await kb.press('Enter')
  await expect
    .poll(() => countOccurrences(readFileSync(indexPath, 'utf8'), 'const MAC = 9'), {
      timeout: 10_000
    })
    .toBe(3)
})

// Proves the Orca-mapped `:set` options reach Monaco and `:q` closes the tab.
test('@golden vim :set toggles line numbers and :q closes the editor', async ({
  orcaPage,
  testRepoPath,
  registerPostElectronShutdownCleanup
}) => {
  const { monaco } = await openVimEditor(
    { orcaPage, testRepoPath, registerPostElectronShutdownCleanup },
    'vim-exset'
  )
  const kb = orcaPage.keyboard
  const lineNumbers = monaco.locator('.line-numbers')
  await expect(lineNumbers.first()).toBeVisible({ timeout: 5_000 })

  // `:set nonumber` maps to Monaco lineNumbers:'off' -> the gutter numbers disappear.
  await kb.type(':set nonumber')
  await kb.press('Enter')
  await expect(lineNumbers).toHaveCount(0, { timeout: 5_000 })

  // `:set number` brings them back.
  await kb.type(':set number')
  await kb.press('Enter')
  await expect(lineNumbers.first()).toBeVisible({ timeout: 5_000 })

  // `:q` closes the editor tab (no unsaved edits were made).
  const fileEditor = orcaPage.locator('[data-orca-file-editor]')
  await expect(fileEditor).toHaveCount(1)
  await kb.type(':q')
  await kb.press('Enter')
  await expect(fileEditor).toHaveCount(0, { timeout: 5_000 })
})
