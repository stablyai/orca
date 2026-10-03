import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

// Throwaway verification for the literal-path row (PR #23038). Out-of-worktree
// absolute path → pinned "Open <path>" row → Enter opens it in the editor.
test('cmd+p opens a pasted out-of-worktree absolute path', async ({ electronApp, orcaPage }) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'orca-quick-open-literal-'))
  const filePath = path.join(dir, 'probe-target.md')
  writeFileSync(filePath, '# literal path probe\n')
  try {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)

    await electronApp.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send('ui:openQuickOpen')
    })
    const dialog = orcaPage.getByRole('dialog', { name: 'Go to file' })
    await expect(dialog).toBeVisible()
    const input = dialog.locator('input[placeholder="Go to file..."]')

    // 1) Bare filename stays fuzzy-only: no pinned row.
    await input.fill('probe-target.md')
    await expect(dialog.getByRole('option').filter({ hasText: 'Open ' })).toHaveCount(0)

    // 2) Absolute out-of-worktree path: pinned row appears after the stat.
    await input.fill(filePath)
    const pinned = dialog.locator('[cmdk-item]').filter({ hasText: `Open ${filePath}` })
    await expect(pinned).toBeVisible({ timeout: 5_000 })
    await expect(dialog.locator('[cmdk-item]').first()).toHaveText(/Open .*probe-target\.md/)
    const proofPath = process.env.ORCA_QUICK_OPEN_PROOF_PATH
    if (proofPath) {
      await orcaPage.screenshot({ path: proofPath })
    }

    await orcaPage.keyboard.press('Enter')
    await expect(dialog).toBeHidden()
    await expect(orcaPage.locator('.editor-header-path').first()).toContainText('probe-target.md', {
      timeout: 20_000
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
