import { renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test, expect } from './helpers/mcode-app'
import { openFileExplorer } from './helpers/file-explorer'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

test('refreshes the visible tree after external Windows file changes', async ({ mcodePage }) => {
  await waitForSessionReady(mcodePage)
  await waitForActiveWorktree(mcodePage)
  await mcodePage.evaluate(() => window.__store?.getState().setRightSidebarOpen(false))
  await expect
    .poll(() => mcodePage.evaluate(() => window.__store?.getState().rightSidebarOpen))
    .toBe(false)
  await openFileExplorer(mcodePage)

  const worktreePath = await mcodePage.evaluate(() => {
    const state = window.__store?.getState()
    const worktreeId = state?.activeWorktreeId
    if (!state || !worktreeId) {
      throw new Error('active worktree unavailable')
    }
    const worktree = Object.values(state.worktreesByRepo)
      .flat()
      .find((candidate) => candidate.id === worktreeId)
    if (!worktree) {
      throw new Error('active worktree path unavailable')
    }
    return worktree.path
  })

  const originalName = 'watch-refresh-case.txt'
  const renamedName = 'WATCH-REFRESH-CASE.txt'
  const originalPath = path.join(worktreePath, originalName)
  const renamedPath = path.join(worktreePath, renamedName)
  const row = (name: string) =>
    mcodePage
      .locator('[data-file-explorer-row]')
      .filter({ hasText: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) })

  rmSync(originalPath, { force: true })
  rmSync(renamedPath, { force: true })
  try {
    await expect(row('README.md')).toBeVisible({ timeout: 10_000 })
    await mcodePage.waitForTimeout(2_000)

    writeFileSync(originalPath, 'created outside MCode\n')
    await expect(row(originalName)).toBeVisible({ timeout: 10_000 })

    renameSync(originalPath, renamedPath)
    await expect(row(renamedName)).toBeVisible({ timeout: 10_000 })
    await expect(row(originalName)).toHaveCount(0, { timeout: 10_000 })

    rmSync(renamedPath)
    await expect(row(renamedName)).toHaveCount(0, { timeout: 10_000 })
  } finally {
    rmSync(originalPath, { force: true })
    rmSync(renamedPath, { force: true })
  }
})
