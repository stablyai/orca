import { execFileSync } from 'node:child_process'
import { realpathSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { test } from '../desktop/electron-fixtures/orca-app'
import { expect } from '@stablyai/playwright-test'
import {
  cleanupGoldenWorktree,
  createGoldenWorktree,
  GOLDEN_ADDED_LINE,
  GOLDEN_CHANGED_PATH,
  GOLDEN_REMOVED_LINE,
  openGoldenSourceControl,
  seedGoldenSourceEdit
} from './golden-source-control'
import { waitForSessionReady } from '../desktop/renderer-probes/store'

test('@golden opens an unstaged file diff from Source Control', async ({
  orcaPage,
  testRepoPath,
  registerPostElectronShutdownCleanup
}) => {
  const fixture = createGoldenWorktree(testRepoPath, 'open-diff')
  registerPostElectronShutdownCleanup(async () => cleanupGoldenWorktree(testRepoPath, fixture))
  seedGoldenSourceEdit(fixture.worktreePath)

  await waitForSessionReady(orcaPage)
  await openGoldenSourceControl(orcaPage, testRepoPath, fixture)

  const changedFile = orcaPage
    .locator('[data-testid="source-control-entry"]')
    .filter({ hasText: path.basename(GOLDEN_CHANGED_PATH) })
  await expect(changedFile).toBeVisible({ timeout: 15_000 })
  await changedFile.click()

  await expect(orcaPage.locator('.monaco-diff-editor')).toBeVisible({ timeout: 20_000 })
  await expect(
    orcaPage
      .locator('.original-in-monaco-diff-editor .view-line')
      .filter({ hasText: GOLDEN_REMOVED_LINE })
  ).toBeVisible()
  await expect(
    orcaPage
      .locator('.modified-in-monaco-diff-editor .view-line')
      .filter({ hasText: GOLDEN_ADDED_LINE })
  ).toBeVisible()
  await expect(orcaPage.locator('.editor-header-path').first()).toHaveAttribute(
    'title',
    `${realpathSync(path.join(fixture.worktreePath, GOLDEN_CHANGED_PATH)).replaceAll('\\', '/')} (diff)`
  )

  const probe = orcaPage.getByRole('button', { name: /Source Control/ })
  await probe.focus()
  await expect(probe).toBeFocused()
})

test('@golden navigates changed files in panel order from diff controls', async ({
  orcaPage,
  testRepoPath,
  registerPostElectronShutdownCleanup
}) => {
  const fixture = createGoldenWorktree(testRepoPath, 'diff-file-navigation')
  registerPostElectronShutdownCleanup(async () => cleanupGoldenWorktree(testRepoPath, fixture))
  seedMultiFileNavigationFixture(fixture.worktreePath)

  await waitForSessionReady(orcaPage)
  await openGoldenSourceControl(orcaPage, testRepoPath, fixture)

  await openEntry(orcaPage, 'unstaged.ts')
  await expectActiveEditor(orcaPage, fixture.worktreePath, 'unstaged.ts', UNSTAGED_DIFF)

  // Sweep order is the panel's: Changes (deleted.ts, unstaged.ts, untracked.ts), then Staged.
  await navigateWithHeaderUntil(
    orcaPage,
    fixture.worktreePath,
    'Next change',
    'untracked.ts',
    UNTRACKED_CHANGES
  )
  await navigateWithHeaderUntil(
    orcaPage,
    fixture.worktreePath,
    'Next change',
    'staged-only.ts',
    STAGED_DIFF
  )
  // staged-only.ts is the last row: next wraps within the file instead of crossing files.
  await pressAndExpectStay(
    orcaPage,
    fixture.worktreePath,
    'Next change',
    'staged-only.ts',
    STAGED_DIFF
  )

  await navigateWithHeaderUntil(
    orcaPage,
    fixture.worktreePath,
    'Previous change',
    'untracked.ts',
    UNTRACKED_CHANGES
  )
  await navigateWithHeaderUntil(
    orcaPage,
    fixture.worktreePath,
    'Previous change',
    'unstaged.ts',
    UNSTAGED_CHANGES
  )
  await navigateWithHeaderUntil(
    orcaPage,
    fixture.worktreePath,
    'Previous change',
    'deleted.ts',
    DELETED_DIFF
  )
  // deleted.ts is the first row: previous wraps within the file.
  await pressAndExpectStay(
    orcaPage,
    fixture.worktreePath,
    'Previous change',
    'deleted.ts',
    DELETED_DIFF
  )

  // F7/Shift+F7 are captured by diff tabs; hops land on Changes tabs, which step through the header arrows.
  await pressDiffShortcutUntil(
    orcaPage,
    fixture.worktreePath,
    'F7',
    'unstaged.ts',
    UNSTAGED_CHANGES
  )

  // Staging the active file drops its working-tree row; the hop must continue from where that row sat.
  execFileSync('git', ['add', 'unstaged.ts'], { cwd: fixture.worktreePath, stdio: 'pipe' })
  await expect
    .poll(() => getShownRowKeys(orcaPage), { timeout: 20_000 })
    .not.toContain('unstaged::unstaged.ts')
  // One click only: a hop that started from the file's new staged row would land on untracked.ts instead.
  await orcaPage.getByRole('button', { name: 'Previous change' }).click()
  await expectActiveEditor(orcaPage, fixture.worktreePath, 'deleted.ts', DELETED_DIFF)

  // A partially staged file keeps its staged row for the staged diff, in both directions.
  writeFileSync(path.join(fixture.worktreePath, 'unstaged.ts'), 'one\ntwo\nthree\n')
  await expect
    .poll(() => getShownRowKeys(orcaPage), { timeout: 20_000 })
    .toContain('unstaged::unstaged.ts')
  await openEntry(orcaPage, 'unstaged.ts', 'last')
  await expectActiveEditor(orcaPage, fixture.worktreePath, 'unstaged.ts', PARTIALLY_STAGED_DIFF)
  await pressDiffShortcutUntil(
    orcaPage,
    fixture.worktreePath,
    'Shift+F7',
    'staged-only.ts',
    STAGED_DIFF
  )
  await pressDiffShortcutUntil(
    orcaPage,
    fixture.worktreePath,
    'F7',
    'unstaged.ts',
    PARTIALLY_STAGED_DIFF
  )
  await openEntry(orcaPage, 'staged-only.ts')
  await expectActiveEditor(orcaPage, fixture.worktreePath, 'staged-only.ts', STAGED_DIFF)
  await pressDiffShortcutUntil(
    orcaPage,
    fixture.worktreePath,
    'Shift+F7',
    'untracked.ts',
    UNTRACKED_CHANGES
  )
})

const UNSTAGED_DIFF: RenderedEditor = { title: ' (diff)', addedLine: 'two' }
const DELETED_DIFF: RenderedEditor = { title: ' (diff)', removedLine: 'one' }
const STAGED_DIFF: RenderedEditor = { title: ' (staged diff)', addedLine: 'two' }
// Only the staged line shows in the staged diff; 'three' is the new working-tree change.
const PARTIALLY_STAGED_DIFF: RenderedEditor = { title: ' (staged diff)', addedLine: 'two' }
// Hops into working-tree rows land on Changes tabs.
const UNSTAGED_CHANGES: RenderedEditor = { title: '', addedLine: 'two' }
const UNTRACKED_CHANGES: RenderedEditor = { title: '', addedLine: 'new' }

// Header title suffix and the lines the rendered editor must show.
type RenderedEditor = { title: string; removedLine?: string; addedLine?: string }

function seedMultiFileNavigationFixture(worktreePath: string): void {
  writeFileSync(path.join(worktreePath, 'unstaged.ts'), 'one\n')
  writeFileSync(path.join(worktreePath, 'staged-only.ts'), 'one\n')
  writeFileSync(path.join(worktreePath, 'deleted.ts'), 'one\n')
  execFileSync('git', ['add', 'unstaged.ts', 'staged-only.ts', 'deleted.ts'], {
    cwd: worktreePath,
    stdio: 'pipe'
  })
  execFileSync('git', ['commit', '-m', 'diff navigation fixture'], {
    cwd: worktreePath,
    stdio: 'pipe'
  })
  writeFileSync(path.join(worktreePath, 'unstaged.ts'), 'one\ntwo\n')
  writeFileSync(path.join(worktreePath, 'staged-only.ts'), 'one\ntwo\n')
  execFileSync('git', ['add', 'staged-only.ts'], { cwd: worktreePath, stdio: 'pipe' })
  rmSync(path.join(worktreePath, 'deleted.ts'))
  writeFileSync(path.join(worktreePath, 'untracked.ts'), 'new\n')
}

async function getActiveEditorRelativePath(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const state = window.__store?.getState()
    return state?.openFiles.find((file) => file.id === state.activeFileId)?.relativePath ?? null
  })
}

async function getShownRowKeys(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Object.values(window.__store?.getState().sourceControlVisibleRowsByWorktree ?? {})
      .flat()
      .map((row) => row.key)
  )
}

// 'last' picks the Staged section's row of a file that also has working-tree changes.
async function openEntry(
  page: Page,
  relativePath: string,
  which: 'first' | 'last' = 'first'
): Promise<void> {
  await page
    .locator('[data-testid="source-control-entry"]')
    .filter({ hasText: relativePath })
    [which]()
    .click()
}

// Store state alone passes even when the pane renders nothing: assert what the user sees.
async function expectActiveEditor(
  page: Page,
  worktreePath: string,
  relativePath: string,
  rendered: RenderedEditor
): Promise<void> {
  await expect.poll(() => getActiveEditorRelativePath(page), { timeout: 10_000 }).toBe(relativePath)
  await expect(page.locator('.editor-header-path').first()).toHaveAttribute(
    'title',
    `${path.join(realpathSync(worktreePath), relativePath).replaceAll('\\', '/')}${rendered.title}`
  )
  const viewLines = page.locator(
    rendered.title ? '.modified-in-monaco-diff-editor .view-line' : '.monaco-editor .view-line'
  )
  if (rendered.removedLine) {
    await expect(
      page
        .locator('.original-in-monaco-diff-editor .view-line')
        .filter({ hasText: rendered.removedLine })
    ).toBeVisible()
  }
  if (rendered.addedLine) {
    await expect(viewLines.filter({ hasText: rendered.addedLine })).toBeVisible()
  }
}

async function pressAndExpectStay(
  page: Page,
  worktreePath: string,
  buttonName: 'Next change' | 'Previous change',
  expectedRelativePath: string,
  rendered: RenderedEditor
): Promise<void> {
  const button = page.getByRole('button', { name: buttonName })
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await button.click()
  }
  await expectActiveEditor(page, worktreePath, expectedRelativePath, rendered)
}

async function navigateWithHeaderUntil(
  page: Page,
  worktreePath: string,
  buttonName: 'Next change' | 'Previous change',
  expectedRelativePath: string,
  rendered: RenderedEditor
): Promise<void> {
  const button = page.getByRole('button', { name: buttonName })
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await button.click()
    try {
      await expect
        .poll(() => getActiveEditorRelativePath(page), { timeout: 2_000 })
        .toBe(expectedRelativePath)
      await expectActiveEditor(page, worktreePath, expectedRelativePath, rendered)
      return
    } catch {
      // Keep stepping through any remaining hunks in the current file.
    }
  }
  await expectActiveEditor(page, worktreePath, expectedRelativePath, rendered)
}

async function pressDiffShortcutUntil(
  page: Page,
  worktreePath: string,
  shortcut: 'F7' | 'Shift+F7',
  expectedRelativePath: string,
  rendered: RenderedEditor
): Promise<void> {
  await page.locator('.monaco-diff-editor textarea').first().focus()
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await page.keyboard.press(shortcut)
    try {
      await expect
        .poll(() => getActiveEditorRelativePath(page), { timeout: 2_000 })
        .toBe(expectedRelativePath)
      await expectActiveEditor(page, worktreePath, expectedRelativePath, rendered)
      return
    } catch {
      // Keep stepping through any remaining hunks in the current file.
    }
  }
  await expectActiveEditor(page, worktreePath, expectedRelativePath, rendered)
}
