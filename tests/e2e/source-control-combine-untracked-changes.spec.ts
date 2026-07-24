import { test, expect } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import type { Page } from '@playwright/test'

type SeededChanges = {
  untrackedFileName: string
  modifiedFileName: string
}

async function openSourceControl(page: Page): Promise<void> {
  await page.evaluate(() => {
    const state = window.__store?.getState()
    state?.setRightSidebarOpen(true)
  })
  await page.getByRole('button', { name: /Source Control/ }).click()
}

async function seedUntrackedAndModifiedFiles(page: Page): Promise<SeededChanges> {
  return page.evaluate(async () => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is not available')
    }

    const state = store.getState()
    const worktreeId = state.activeWorktreeId
    const worktree = Object.values(state.worktreesByRepo)
      .flat()
      .find((entry) => entry.id === worktreeId)
    if (!worktree) {
      throw new Error('active worktree not found')
    }

    const separator = worktree.path.includes('\\') ? '\\' : '/'
    const untrackedFileName = `orca-combine-untracked-${Date.now()}.txt`
    await window.api.fs.writeFile({
      filePath: `${worktree.path}${separator}${untrackedFileName}`,
      content: 'new untracked file\n'
    })

    const modifiedFileName = 'README.md'
    const modifiedFilePath = `${worktree.path}${separator}${modifiedFileName}`
    const original = await window.api.fs.readFile({ filePath: modifiedFilePath })
    await window.api.fs.writeFile({
      filePath: modifiedFilePath,
      content: `${original.content}\n<!-- orca-combine-untracked-changes e2e -->\n`
    })

    const status = await window.api.git.status({ worktreePath: worktree.path })
    state.setGitStatus(worktree.id, status)

    return { untrackedFileName, modifiedFileName }
  })
}

async function setCombineUntrackedChanges(page: Page, enabled: boolean): Promise<void> {
  await page.evaluate(
    (value) =>
      window.__store?.getState().updateSettings({ sourceControlCombineUntrackedChanges: value }),
    enabled
  )
}

test.describe('Source Control combine untracked with changes', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
  })

  test('folds Untracked Files into Changes only when the setting is on', async ({ orcaPage }) => {
    const seeded = await seedUntrackedAndModifiedFiles(orcaPage)
    await openSourceControl(orcaPage)

    // Why: the header's accessible name includes the row count ("Changes 1"),
    // and "Discard changes"/"Stage changes" row buttons also contain "changes".
    const changesHeader = orcaPage.getByRole('button', { name: /^Changes \d+$/ })
    const untrackedHeader = orcaPage.getByRole('button', { name: /^Untracked Files \d+$/ })
    const untrackedRow = orcaPage
      .locator('[data-testid="source-control-entry"]')
      .filter({ hasText: seeded.untrackedFileName })
    const modifiedRow = orcaPage
      .locator('[data-testid="source-control-entry"]')
      .filter({ hasText: seeded.modifiedFileName })

    await expect(changesHeader).toBeVisible()
    await expect(untrackedHeader).toBeVisible()
    await expect(untrackedRow).toBeVisible()
    await expect(modifiedRow).toBeVisible()

    await setCombineUntrackedChanges(orcaPage, true)

    await expect(untrackedHeader).toHaveCount(0)
    await expect(changesHeader).toBeVisible()
    await expect(untrackedRow).toBeVisible()
    await expect(modifiedRow).toBeVisible()

    await setCombineUntrackedChanges(orcaPage, false)

    await expect(untrackedHeader).toBeVisible()
    await expect(untrackedRow).toBeVisible()
    await expect(modifiedRow).toBeVisible()
  })
})
