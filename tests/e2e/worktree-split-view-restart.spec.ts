import { existsSync, readFileSync } from 'node:fs'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { attachRepoAndOpenTerminal, createRestartSession } from './helpers/orca-restart'
import { getActiveWorktreeId, waitForSessionReady } from './helpers/store'
import { TEST_REPO_PATH_FILE } from './global-setup'

// Why both: the menu follows the OS locale when the profile names none.
const OPEN_SPLIT_VIEW = /^(Open in Split View|분할 화면에서 열기)$/

function seededRepoPath(): string {
  const repoPath = existsSync(TEST_REPO_PATH_FILE)
    ? readFileSync(TEST_REPO_PATH_FILE, 'utf8').trim()
    : ''
  if (!repoPath || !existsSync(repoPath)) {
    throw new Error('Split view restart E2E requires the seeded test repo from global setup')
  }
  return repoPath
}

async function waitForSecondaryWorktreeId(page: Page): Promise<string> {
  let id: string | null = null
  await expect
    .poll(
      async () => {
        id = await page.evaluate(async () => {
          const store = window.__store
          if (!store) {
            return null
          }
          // Why: the seeded worktree is external, so it only lists after a refetch past the visibility flip.
          for (const repo of store.getState().repos) {
            await store.getState().fetchWorktrees(repo.id)
          }
          return (
            Object.values(store.getState().worktreesByRepo)
              .flat()
              .find((entry) => entry.branch.replace(/^refs\/heads\//, '') === 'e2e-secondary')
              ?.id ?? null
          )
        })
        return id
      },
      { timeout: 30_000 }
    )
    .not.toBeNull()
  return id ?? ''
}

test('restores the split view after quit and relaunch', async (// oxlint-disable-next-line no-empty-pattern -- this test owns both Electron launches.
{}, testInfo) => {
  test.setTimeout(300_000)
  const repoPath = seededRepoPath()
  const session = createRestartSession(testInfo)
  let firstApp: ElectronApplication | null = null
  let secondApp: ElectronApplication | null = null

  try {
    const first = await session.launch()
    firstApp = first.app
    await waitForSessionReady(first.page)
    const leftWorktreeId = await attachRepoAndOpenTerminal(first.page, repoPath)
    const rightWorktreeId = await waitForSecondaryWorktreeId(first.page)
    expect(rightWorktreeId).not.toBe(leftWorktreeId)

    await first.page
      .locator(`[role="option"][data-worktree-id="${rightWorktreeId}"]`)
      .click({ button: 'right' })
    await first.page.getByRole('menuitem', { name: OPEN_SPLIT_VIEW }).click()
    const left = first.page.locator('[data-worktree-split-side="left"]')
    await expect(left).toBeVisible({ timeout: 20_000 })
    await expect(first.page.locator('[data-worktree-split-side="right"]')).toBeVisible()
    // Input sits on the left so the relaunch must restore the focused side, not just the pair.
    await left.click({ position: { x: 40, y: 120 } })
    await expect.poll(() => getActiveWorktreeId(first.page)).toBe(leftWorktreeId)

    await session.close(firstApp)
    firstApp = null

    const second = await session.launch()
    secondApp = second.app
    await waitForSessionReady(second.page)
    await expect(second.page.locator('[data-worktree-split-side="left"]')).toBeVisible({
      timeout: 30_000
    })
    await expect(second.page.locator('[data-worktree-split-side="right"]')).toBeVisible()
    expect(
      await second.page.evaluate(() => window.__store?.getState().worktreeSplitViewPair)
    ).toMatchObject({ leftWorktreeId, rightWorktreeId })
    expect(await getActiveWorktreeId(second.page)).toBe(leftWorktreeId)
    if (process.env.ORCA_SPLIT_VIEW_SCREENSHOT) {
      await second.page.screenshot({ path: process.env.ORCA_SPLIT_VIEW_SCREENSHOT })
    }
  } finally {
    for (const app of [secondApp, firstApp]) {
      if (app) {
        await session.close(app).catch(() => undefined)
      }
    }
    await session.dispose()
  }
})
