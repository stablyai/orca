import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { getActiveWorktreeId, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { waitForActiveTerminalManager } from './helpers/terminal'

// Why both: the menu follows the OS locale when the profile names none.
const OPEN_SPLIT_VIEW = /^(Open in Split View|분할 화면에서 열기)$/
const CLOSE_SPLIT_VIEW = /^(Close Split View|분할 화면 닫기)$/

async function getSecondaryWorktreeId(page: Page): Promise<string> {
  return page.evaluate(() => {
    const state = window.__store?.getState()
    const worktree = Object.values(state?.worktreesByRepo ?? {})
      .flat()
      .find((entry) => entry.branch.replace(/^refs\/heads\//, '') === 'e2e-secondary')
    if (!worktree) {
      throw new Error('seeded e2e-secondary worktree not found')
    }
    return worktree.id
  })
}

function sidebarRow(page: Page, worktreeId: string) {
  return page.locator(`[role="option"][data-worktree-id="${worktreeId}"]`)
}

test('shows two worktrees side by side and hands input to the clicked side', async ({
  orcaPage
}) => {
  test.setTimeout(180_000)
  await waitForSessionReady(orcaPage)
  const leftWorktreeId = await waitForActiveWorktree(orcaPage)
  await waitForActiveTerminalManager(orcaPage, 30_000)
  const rightWorktreeId = await getSecondaryWorktreeId(orcaPage)
  expect(rightWorktreeId).not.toBe(leftWorktreeId)

  try {
    await sidebarRow(orcaPage, rightWorktreeId).click({ button: 'right' })
    await orcaPage.getByRole('menuitem', { name: OPEN_SPLIT_VIEW }).click()
    await expect.poll(() => getActiveWorktreeId(orcaPage)).toBe(rightWorktreeId)

    const left = orcaPage.locator('[data-worktree-split-side="left"]')
    const right = orcaPage.locator('[data-worktree-split-side="right"]')
    await expect(left).toBeVisible({ timeout: 20_000 })
    await expect(right).toBeVisible()
    const leftBox = await left.boundingBox()
    const rightBox = await right.boundingBox()
    expect(leftBox && rightBox).toBeTruthy()
    if (leftBox && rightBox) {
      expect(leftBox.x + leftBox.width).toBeLessThanOrEqual(rightBox.x + 1)
      expect(Math.abs(leftBox.width - rightBox.width)).toBeLessThan(16)
    }
    if (process.env.ORCA_SPLIT_VIEW_SCREENSHOT) {
      await orcaPage.screenshot({ path: process.env.ORCA_SPLIT_VIEW_SCREENSHOT })
    }

    // Clicking the partner hands it input without collapsing the split.
    await left.click({ position: { x: 40, y: 120 } })
    await expect.poll(() => getActiveWorktreeId(orcaPage)).toBe(leftWorktreeId)
    await expect(left).toBeVisible()
    await expect(right).toBeVisible()

    await orcaPage.getByRole('button', { name: CLOSE_SPLIT_VIEW }).click()
    await expect(right).toHaveCount(0)
    await expect(left).toHaveCount(0)
  } finally {
    await orcaPage
      .evaluate(() => window.__store?.getState().closeWorktreeSplitView())
      .catch(() => undefined)
  }
})

test('splits worktrees from two different repositories', async ({ orcaPage }) => {
  test.setTimeout(180_000)
  await waitForSessionReady(orcaPage)
  const leftWorktreeId = await waitForActiveWorktree(orcaPage)
  await waitForActiveTerminalManager(orcaPage, 30_000)

  const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-split-view-'))
  const secondRepositoryPath = path.join(tempRoot, 'split-view-second-repo')
  mkdirSync(secondRepositoryPath, { recursive: true })
  for (const args of [
    ['init'],
    ['config', 'user.email', 'e2e@test.local'],
    ['config', 'user.name', 'E2E Test'],
    ['commit', '--allow-empty', '-m', 'Initial commit']
  ]) {
    execFileSync('git', args, { cwd: secondRepositoryPath, stdio: 'pipe' })
  }

  try {
    const rightWorktreeId = await orcaPage.evaluate(async (repositoryPath) => {
      const store = window.__store
      const repository = await store?.getState().addRepoPath(repositoryPath)
      if (!store || !repository) {
        throw new Error(`Failed to add repository at ${repositoryPath}`)
      }
      for (let attempt = 0; attempt < 100; attempt++) {
        const worktree = store.getState().worktreesByRepo[repository.id]?.[0]
        if (worktree) {
          return worktree.id
        }
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      throw new Error('second repository worktree never appeared')
    }, secondRepositoryPath)
    await expect.poll(() => getActiveWorktreeId(orcaPage)).toBe(leftWorktreeId)

    await sidebarRow(orcaPage, rightWorktreeId).click({ button: 'right' })
    await orcaPage.getByRole('menuitem', { name: OPEN_SPLIT_VIEW }).click()
    await expect.poll(() => getActiveWorktreeId(orcaPage)).toBe(rightWorktreeId)

    const left = orcaPage.locator('[data-worktree-split-side="left"]')
    const right = orcaPage.locator('[data-worktree-split-side="right"]')
    if (process.env.ORCA_SPLIT_VIEW_SCREENSHOT) {
      await orcaPage.screenshot({
        path: process.env.ORCA_SPLIT_VIEW_SCREENSHOT.replace(/\.png$/, '-cross-repo.png')
      })
    }
    await expect(left).toBeVisible({ timeout: 20_000 })
    await expect(right).toBeVisible()

    // Going to a worktree outside the pair ends the split; coming back stays single.
    const outsideWorktreeId = await getSecondaryWorktreeId(orcaPage)
    await sidebarRow(orcaPage, outsideWorktreeId).click()
    await expect.poll(() => getActiveWorktreeId(orcaPage)).toBe(outsideWorktreeId)
    await expect(left).toHaveCount(0)
    await sidebarRow(orcaPage, rightWorktreeId).click()
    await expect.poll(() => getActiveWorktreeId(orcaPage)).toBe(rightWorktreeId)
    await expect(left).toHaveCount(0)

    // The previous pair no longer blocks pairing the same rows again.
    await sidebarRow(orcaPage, leftWorktreeId).click({ button: 'right' })
    await orcaPage.getByRole('menuitem', { name: OPEN_SPLIT_VIEW }).click()
    await expect.poll(() => getActiveWorktreeId(orcaPage)).toBe(leftWorktreeId)
    await expect(left).toBeVisible({ timeout: 20_000 })
    await expect(right).toBeVisible()
  } finally {
    await orcaPage
      .evaluate(() => window.__store?.getState().closeWorktreeSplitView())
      .catch(() => undefined)
    rmSync(tempRoot, { recursive: true, force: true })
  }
})
