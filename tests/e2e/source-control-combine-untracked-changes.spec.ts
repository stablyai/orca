import path from 'node:path'
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

async function getActiveWorktree(page: Page): Promise<{ id: string; path: string }> {
  return page.evaluate(() => {
    const state = window.__store?.getState()
    if (!state) {
      throw new Error('window.__store is not available')
    }
    const worktreeId = state.activeWorktreeId
    const worktree = Object.values(state.worktreesByRepo)
      .flat()
      .find((entry) => entry.id === worktreeId)
    if (!worktree) {
      throw new Error('active worktree not found')
    }
    return { id: worktree.id, path: worktree.path }
  })
}

async function seedUntrackedAndModifiedFiles(page: Page): Promise<SeededChanges> {
  // Why: worktree.path uses the OS-native separator of the machine running
  // Orca — resolve the seeded file paths with node:path here (Node context)
  // rather than inferring the separator inside the renderer callback.
  const worktree = await getActiveWorktree(page)
  const untrackedFileName = `orca-combine-untracked-${Date.now()}.txt`
  const untrackedFilePath = path.join(worktree.path, untrackedFileName)
  const modifiedFileName = 'README.md'
  const modifiedFilePath = path.join(worktree.path, modifiedFileName)

  await page.evaluate(
    async ({ worktreeId, worktreePath, untrackedFilePath, modifiedFilePath }) => {
      const store = window.__store
      if (!store) {
        throw new Error('window.__store is not available')
      }

      await window.api.fs.writeFile({
        filePath: untrackedFilePath,
        content: 'new untracked file\n'
      })

      const original = await window.api.fs.readFile({ filePath: modifiedFilePath })
      await window.api.fs.writeFile({
        filePath: modifiedFilePath,
        content: `${original.content}\n<!-- orca-combine-untracked-changes e2e -->\n`
      })

      const status = await window.api.git.status({ worktreePath })
      store.getState().setGitStatus(worktreeId, status)
    },
    { worktreeId: worktree.id, worktreePath: worktree.path, untrackedFilePath, modifiedFilePath }
  )

  return { untrackedFileName, modifiedFileName }
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
