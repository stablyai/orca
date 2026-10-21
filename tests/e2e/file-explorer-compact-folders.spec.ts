import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runProcess } from '@orca/process-host'
import type { Locator, Page } from '@stablyai/playwright-test'
import { test as base, expect } from './helpers/orca-app'
import { openFileExplorer } from './helpers/file-explorer'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

async function git(cwd: string, args: string[]): Promise<void> {
  const result = await runProcess({ program: 'git', args, cwd })
  if (result.code !== 0) {
    throw new Error(result.stderr)
  }
}

const test = base.extend({
  minimumSeededWorktreeCount: 1,
  // Why a clone: the worker's seeded repo is shared, and the Java tree would leak into later specs.
  seededRepoPath: async ({ testRepoPath }, provideFixture) => {
    const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), 'orca-compact-folders-'))
    const repo = path.join(fixtureRoot, 'repo')
    await git(fixtureRoot, ['clone', '--local', testRepoPath, repo])
    await git(repo, ['config', 'user.email', 'compact-folders@example.invalid'])
    await git(repo, ['config', 'user.name', 'Compact folders'])
    for (const file of [
      'app/src/main/java/com/example/app/Main.java',
      'app/src/main/java/com/example/app/util/Strings.java',
      'app/src/test/java/com/example/app/MainTest.java'
    ]) {
      mkdirSync(path.dirname(path.join(repo, file)), { recursive: true })
      writeFileSync(path.join(repo, file), `// ${path.basename(file)}\n`)
    }
    await git(repo, ['add', '.'])
    await git(repo, ['commit', '-m', 'Java package tree'])
    try {
      await provideFixture(repo)
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true })
    }
  }
})

function rowNamed(page: Page, name: string): Locator {
  return page.locator('[data-orca-explorer-shell] [data-file-explorer-row]').filter({
    has: page.locator('[data-file-explorer-row-name]', {
      hasText: new RegExp(`^${name.replaceAll('.', '\\.')}$`)
    })
  })
}

function focusedRowName(): string {
  return document.activeElement?.querySelector('[data-file-explorer-row-name]')?.textContent ?? ''
}

test('compact folders folds single-folder chains and keeps rows usable', async ({
  orcaPage,
  seededRepoPath
}) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await orcaPage.evaluate(async () => {
    // Why: the spec reads English labels; the host may run another system locale.
    await window.__store!.getState().updateSettings({
      uiLanguage: 'en',
      fileExplorerCompactFolders: true
    })
  })
  await openFileExplorer(orcaPage)

  // One click on the head of a single-folder chain opens the whole chain into one row.
  await rowNamed(orcaPage, 'app').click()
  await expect(rowNamed(orcaPage, 'app/src')).toBeVisible()
  await rowNamed(orcaPage, 'test').click()
  await expect(rowNamed(orcaPage, 'test/java/com/example/app')).toBeVisible()
  await expect(rowNamed(orcaPage, 'MainTest.java')).toBeVisible()
  await rowNamed(orcaPage, 'main').click()
  await expect(rowNamed(orcaPage, 'main/java/com/example/app')).toBeVisible()
  await expect(rowNamed(orcaPage, 'Main.java')).toBeVisible()
  await expect(rowNamed(orcaPage, 'util')).toBeVisible()

  // Keyboard: Left collapses the chain row, Right reopens it, Down enters it, Left returns.
  const compactRow = rowNamed(orcaPage, 'main/java/com/example/app')
  await compactRow.focus()
  await orcaPage.keyboard.press('ArrowLeft')
  await expect(rowNamed(orcaPage, 'Main.java')).toHaveCount(0)
  await expect(compactRow).toBeVisible()
  await orcaPage.keyboard.press('ArrowRight')
  await expect(rowNamed(orcaPage, 'Main.java')).toBeVisible()
  // Folders sort first, so the chain row's first child is util.
  await orcaPage.keyboard.press('ArrowDown')
  await expect.poll(() => orcaPage.evaluate(focusedRowName)).toBe('util')
  await orcaPage.keyboard.press('ArrowLeft')
  await expect.poll(() => orcaPage.evaluate(focusedRowName)).toBe('main/java/com/example/app')

  // New File from the chain row creates the file in its deepest folder.
  await compactRow.click({ button: 'right' })
  await orcaPage.getByRole('menuitem', { name: 'New File' }).click()
  const input = orcaPage.locator('[data-orca-explorer-shell] input.border-ring')
  await expect(input).toBeFocused()
  await input.fill('Added.java')
  await input.press('Enter')
  const addedPath = path.join(seededRepoPath, 'app/src/main/java/com/example/app/Added.java')
  await expect.poll(() => existsSync(addedPath)).toBe(true)
  await expect(rowNamed(orcaPage, 'Added.java')).toBeVisible()

  // A file created beside the chain splits it.
  writeFileSync(path.join(seededRepoPath, 'app/src/main/java/com/Note.md'), '# note\n')
  await expect(rowNamed(orcaPage, 'main/java/com')).toBeVisible({ timeout: 15_000 })
  await expect(rowNamed(orcaPage, 'example/app')).toBeVisible()
  await expect(rowNamed(orcaPage, 'Note.md')).toBeVisible()

  // Name filter results fold the same way.
  await orcaPage.getByPlaceholder('Find files').fill('Strings')
  await expect(rowNamed(orcaPage, 'app/src/main/java/com/example/app/util')).toBeVisible({
    timeout: 10_000
  })
  await expect(rowNamed(orcaPage, 'Strings.java')).toBeVisible()
})
