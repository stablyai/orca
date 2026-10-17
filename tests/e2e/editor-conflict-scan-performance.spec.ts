import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import {
  activateGoldenWorktree,
  cleanupGoldenWorktree,
  createGoldenWorktree
} from './helpers/golden-source-control'
import { waitForSessionReady } from './helpers/store'

const relativePath = 'large-conflict.txt'
const lineCount = 60_000

function createConflict(repoPath: string) {
  const worktree = createGoldenWorktree(repoPath, 'conflict-scan')
  const otherBranch = `${worktree.branchName}-incoming`
  const filePath = path.join(worktree.worktreePath, relativePath)
  const tail = `${'generated-data '.padEnd(121, 'x')}\n`.repeat(lineCount)
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: worktree.worktreePath, stdio: 'pipe' })
  writeFileSync(filePath, `base version\n${tail}`)
  git('add', relativePath)
  git('commit', '-m', 'Fixture base')
  git('checkout', '-b', otherBranch)
  writeFileSync(filePath, `incoming version\n${tail}`)
  git('add', relativePath)
  git('commit', '-m', 'Fixture incoming')
  git('checkout', worktree.branchName)
  writeFileSync(filePath, `current version\n${tail}`)
  git('add', relativePath)
  git('commit', '-m', 'Fixture current')
  try {
    git('merge', otherBranch)
  } catch {
    expect(git('status', '--porcelain').toString()).toContain(`UU ${relativePath}`)
  }
  return { ...worktree, otherBranch, filePath }
}

test('updates large conflict highlights immediately while editing', async ({
  orcaPage,
  testRepoPath,
  registerPostElectronShutdownCleanup
}, testInfo) => {
  const fixture = createConflict(testRepoPath)
  registerPostElectronShutdownCleanup(async () => {
    cleanupGoldenWorktree(testRepoPath, fixture)
    execFileSync('git', ['branch', '-D', fixture.otherBranch], { cwd: testRepoPath, stdio: 'pipe' })
  })
  await waitForSessionReady(orcaPage)
  await activateGoldenWorktree(orcaPage, testRepoPath, fixture.worktreePath)
  await orcaPage.evaluate(
    async ({ worktreePath }) => {
      const store = window.__store
      const worktreeId = store?.getState().activeWorktreeId
      if (!store || !worktreeId) {
        throw new Error('Fixture worktree not active')
      }
      const status = await window.api.git.status({ worktreePath })
      store.getState().setGitStatus(worktreeId, status)
      const entry = store
        .getState()
        .gitStatusByWorktree[worktreeId]?.find(
          (candidate) =>
            candidate.path === 'large-conflict.txt' && candidate.conflictStatus === 'unresolved'
        )
      if (!entry) {
        throw new Error('Git conflict missing')
      }
      store
        .getState()
        .openConflictFile(worktreeId, worktreePath, entry, 'plaintext', { preview: false })
    },
    { worktreePath: fixture.worktreePath }
  )
  const editor = orcaPage.locator('.monaco-editor').first()
  await expect(editor).toBeVisible({ timeout: 30_000 })
  await expect(
    editor.locator('.orca-conflict-marker-label').filter({ hasText: 'Current change' })
  ).toBeVisible()
  await expect(
    editor.locator('.orca-conflict-marker-label').filter({ hasText: 'Incoming change' })
  ).toBeVisible()
  await editor.click()
  await orcaPage.keyboard.press('ControlOrMeta+f')
  const findInput = editor.locator('.find-widget .input[aria-label="Find"]')
  await expect(findInput).toBeVisible()
  await findInput.fill('current version')
  await orcaPage.keyboard.press('Enter')
  await orcaPage.keyboard.press('Escape')
  await orcaPage.keyboard.press('ArrowLeft')
  await orcaPage.keyboard.press('Home')
  await expect
    .poll(() => orcaPage.evaluate(() => window.__monacoEditorE2E?.snapshot().selection))
    .toMatchObject({
      selectionStartLineNumber: 2,
      selectionStartColumn: 1,
      positionLineNumber: 2,
      positionColumn: 1
    })
  const samples: number[] = []
  for (const key of '01234') {
    const before = await orcaPage.evaluate(() => performance.now())
    await orcaPage.keyboard.type(key)
    await expect(
      editor
        .locator('.view-line')
        .filter({ hasText: `${'01234'.slice(0, Number(key) + 1)}current version` })
    ).toBeVisible()
    samples.push((await orcaPage.evaluate(() => performance.now())) - before)
  }
  await expect(
    editor.locator('.orca-conflict-marker-label').filter({ hasText: 'Current change' })
  ).toBeVisible()
  await expect(
    editor.locator('.orca-conflict-marker-label').filter({ hasText: 'Incoming change' })
  ).toBeVisible()
  await orcaPage.screenshot({ path: testInfo.outputPath('conflict-typing.png') })
  await writeFile(
    testInfo.outputPath('conflict-edit-performance.json'),
    JSON.stringify(
      { lineCount, samples, totalMs: samples.reduce((sum, sample) => sum + sample, 0) },
      null,
      2
    )
  )
  await orcaPage.keyboard.press('ControlOrMeta+z')
  await expect(editor.locator('.view-line').filter({ hasText: 'current version' })).toBeVisible()
  await expect(
    editor.locator('.view-line').filter({ hasText: '01234current version' })
  ).toHaveCount(0)
})
