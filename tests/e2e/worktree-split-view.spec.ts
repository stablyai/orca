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

    await sidebarRow(orcaPage, rightWorktreeId).click({ button: 'right' })
    await orcaPage.getByRole('menuitem', { name: CLOSE_SPLIT_VIEW }).click()
    await expect(right).toHaveCount(0)
    await expect(left).toHaveCount(0)
  } finally {
    await orcaPage
      .evaluate(() => window.__store?.getState().closeWorktreeSplitView())
      .catch(() => undefined)
  }
})
