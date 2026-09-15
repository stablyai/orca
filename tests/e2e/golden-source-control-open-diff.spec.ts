import { execFileSync } from 'node:child_process'
import { realpathSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import {
  cleanupGoldenWorktree,
  createGoldenWorktree,
  GOLDEN_ADDED_LINE,
  GOLDEN_CHANGED_PATH,
  GOLDEN_REMOVED_LINE,
  openGoldenSourceControl,
  seedGoldenSourceEdit
} from './helpers/golden-source-control'
import { waitForSessionReady } from './helpers/store'

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

test('@golden navigates unstaged and untracked files from diff controls', async ({
  orcaPage,
  testRepoPath,
  registerPostElectronShutdownCleanup
}) => {
  const fixture = createGoldenWorktree(testRepoPath, 'diff-file-navigation')
  registerPostElectronShutdownCleanup(async () => cleanupGoldenWorktree(testRepoPath, fixture))
  seedMultiFileNavigationFixture(fixture.worktreePath)

  await waitForSessionReady(orcaPage)
  await openGoldenSourceControl(orcaPage, testRepoPath, fixture)

  const initialFile = orcaPage
    .locator('[data-testid="source-control-entry"]')
    .filter({ hasText: 'unstaged.ts' })
  await expect(initialFile).toBeVisible({ timeout: 15_000 })
  await initialFile.click()
  await expect(orcaPage.locator('.monaco-diff-editor')).toBeVisible({ timeout: 20_000 })
  await expectActiveEditorPath(orcaPage, fixture.worktreePath, 'unstaged.ts', true)

  await navigateWithHeaderUntil(orcaPage, 'Next change', 'untracked.ts')
  await expectActiveEditorPath(orcaPage, fixture.worktreePath, 'untracked.ts')
  await navigateWithHeaderUntil(orcaPage, 'Next change', 'deleted.ts')
  await expectActiveEditorPath(orcaPage, fixture.worktreePath, 'deleted.ts', true)
  await navigateWithHeaderUntil(orcaPage, 'Next change', 'unstaged.ts')
  await expectActiveEditorPath(orcaPage, fixture.worktreePath, 'unstaged.ts')

  await navigateWithHeaderUntil(orcaPage, 'Previous change', 'deleted.ts')
  await expectActiveEditorPath(orcaPage, fixture.worktreePath, 'deleted.ts', true)
  await pressDiffShortcutUntil(orcaPage, 'F7', 'unstaged.ts')
  await expectActiveEditorPath(orcaPage, fixture.worktreePath, 'unstaged.ts')
  await pressDiffShortcutUntil(orcaPage, 'Shift+F7', 'deleted.ts')
  await expectActiveEditorPath(orcaPage, fixture.worktreePath, 'deleted.ts', true)

  const openedPaths = await orcaPage.evaluate(() =>
    window.__store?.getState().openFiles.map((file) => file.relativePath) ?? []
  )
  expect(openedPaths).not.toContain('staged-only.ts')
})

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

async function expectActiveEditorPath(
  page: Page,
  worktreePath: string,
  relativePath: string,
  isDiff = false
): Promise<void> {
  await expect.poll(() => getActiveEditorRelativePath(page), { timeout: 10_000 }).toBe(relativePath)
  const title = `${path.join(realpathSync(worktreePath), relativePath).replaceAll('\\', '/')}${
    isDiff ? ' (diff)' : ''
  }`
  await expect(page.locator('.editor-header-path').first()).toHaveAttribute('title', title)
}

async function navigateWithHeaderUntil(
  page: Page,
  buttonName: 'Next change' | 'Previous change',
  expectedRelativePath: string
): Promise<void> {
  const button = page.getByRole('button', { name: buttonName })
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await button.click()
    try {
      await expect.poll(() => getActiveEditorRelativePath(page), { timeout: 2_000 }).toBe(expectedRelativePath)
      return
    } catch {
      // Keep stepping through any remaining hunks in the current file.
    }
  }
  await expect.poll(() => getActiveEditorRelativePath(page), { timeout: 1 }).toBe(expectedRelativePath)
}

async function pressDiffShortcutUntil(
  page: Page,
  shortcut: 'F7' | 'Shift+F7',
  expectedRelativePath: string
): Promise<void> {
  await page.locator('.monaco-diff-editor textarea').first().focus()
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await page.keyboard.press(shortcut)
    try {
      await expect.poll(() => getActiveEditorRelativePath(page), { timeout: 2_000 }).toBe(expectedRelativePath)
      return
    } catch {
      // Keep stepping through any remaining hunks in the current file.
    }
  }
  await expect.poll(() => getActiveEditorRelativePath(page), { timeout: 1 }).toBe(expectedRelativePath)
}
