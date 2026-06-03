import { test, expect } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import type { Locator, Page } from '@playwright/test'

type SeededUntrackedFile = {
  fileName: string
}

async function openSourceControl(page: Page): Promise<void> {
  await page.evaluate(() => {
    const state = window.__store?.getState()
    state?.setRightSidebarOpen(true)
  })
  await page.getByRole('button', { name: /Source Control/ }).click()
  await expect(page.getByPlaceholder(/Filter files/)).toBeVisible()
}

async function seedUntrackedFile(page: Page): Promise<SeededUntrackedFile> {
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
    const fileName = `orca-discard-confirm-${Date.now()}.txt`
    const relativePath = fileName
    await window.api.fs.writeFile({
      filePath: `${worktree.path}${separator}${relativePath}`,
      content: 'delete me\n'
    })

    const status = await window.api.git.status({ worktreePath: worktree.path })
    state.setGitStatus(worktree.id, status)
    const statusEntry = status.entries.find((entry) => entry.path.endsWith(fileName))
    if (!statusEntry) {
      throw new Error(`git status did not include ${fileName}`)
    }

    return {
      fileName
    }
  })
}

async function refreshGitStatus(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const store = window.__store
    if (!store) {
      return
    }
    const state = store.getState()
    const worktreeId = state.activeWorktreeId
    const worktree = Object.values(state.worktreesByRepo)
      .flat()
      .find((entry) => entry.id === worktreeId)
    if (!worktree) {
      return
    }
    state.setGitStatus(worktree.id, await window.api.git.status({ worktreePath: worktree.path }))
  })
}

async function deleteUntrackedFileFromRow(row: Locator): Promise<void> {
  const deleteButton = row.getByRole('button', { name: 'Delete untracked file' })
  // Why: row actions are hover/focus revealed; keyboard activation avoids
  // CI hover hit-test drift while exercising the same accessible control.
  await deleteButton.focus()
  await expect(deleteButton).toBeFocused()
  await deleteButton.press('Enter')
}

test.describe('Source Control discard confirmation', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
  })

  test('deletes an untracked file without confirmation', async ({ orcaPage }) => {
    const seededFile = await seedUntrackedFile(orcaPage)
    await openSourceControl(orcaPage)

    const row = orcaPage
      .locator('[data-testid="source-control-entry"]')
      .filter({ hasText: seededFile.fileName })
    await expect(row).toBeVisible()

    await deleteUntrackedFileFromRow(row)

    await expect(
      orcaPage.getByRole('dialog', { name: `Delete "${seededFile.fileName}"?` })
    ).toHaveCount(0)
    await expect(row).toHaveCount(0, { timeout: 10_000 })

    await refreshGitStatus(orcaPage)
    await expect(
      orcaPage.locator('[data-testid="source-control-entry"]').filter({
        hasText: seededFile.fileName
      })
    ).toHaveCount(0)
  })
})
