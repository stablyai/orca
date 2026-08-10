import { test, expect } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import type { Locator, Page } from '@playwright/test'

type SeededUntrackedFile = {
  fileName: string
}

type SeededPartiallyStagedFile = SeededUntrackedFile & {
  filePath: string
}

async function openSourceControl(page: Page): Promise<void> {
  await expect
    .poll(async () => {
      if (await page.getByTestId('source-control-filter-toggle').isVisible()) {
        return true
      }
      await page.evaluate(() => {
        const state = window.__store?.getState()
        state?.setRightSidebarOpen(true)
        state?.setRightSidebarTab('source-control')
      })
      return false
    })
    .toBe(true)
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

async function seedPartiallyStagedFile(page: Page): Promise<SeededPartiallyStagedFile> {
  return page.evaluate(async () => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is not available')
    }
    const state = store.getState()
    const worktree = Object.values(state.worktreesByRepo)
      .flat()
      .find((entry) => entry.id === state.activeWorktreeId)
    if (!worktree) {
      throw new Error('active worktree not found')
    }

    const separator = worktree.path.includes('\\') ? '\\' : '/'
    const fileName = `orca-discard-staged-${Date.now()}.txt`
    const filePath = `${worktree.path}${separator}${fileName}`
    await window.api.fs.writeFile({ filePath, content: 'staged content\n' })
    await window.api.git.stage({ worktreePath: worktree.path, filePath: fileName })
    await window.api.fs.writeFile({ filePath, content: 'staged content\nunstaged content\n' })
    state.setGitStatus(worktree.id, await window.api.git.status({ worktreePath: worktree.path }))
    return { fileName, filePath }
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

async function confirmPendingDelete(page: Page): Promise<void> {
  // Why: the confirm button is auto-focused when the dialog opens
  // (see focusDiscardDialogConfirmButton in source-control-discard-dialog.tsx).
  // Pressing Enter on the row's original button just retriggers open; we need
  // to target the dialog confirm by accessible name.
  const confirmButton = page.getByRole('button', { name: 'Delete' }).last()
  await expect(confirmButton).toBeVisible()
  await confirmButton.click()
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
    await confirmPendingDelete(orcaPage)

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

  test('preserves staged content when discarding through the headed UI @headful', async ({
    orcaPage
  }) => {
    const seededFile = await seedPartiallyStagedFile(orcaPage)
    await openSourceControl(orcaPage)
    const unstagedRow = orcaPage
      .locator('[data-testid="source-control-entry"][data-source-control-area="unstaged"]')
      .filter({ hasText: seededFile.fileName })
    await expect(unstagedRow).toBeVisible()

    const discardButton = unstagedRow.getByRole('button', { name: 'Discard changes' })
    await discardButton.focus()
    await discardButton.press('Enter')
    await orcaPage.getByRole('button', { name: 'Discard', exact: true }).last().click()

    await expect(unstagedRow).toHaveCount(0)
    await expect(
      orcaPage
        .locator('[data-testid="source-control-entry"][data-source-control-area="staged"]')
        .filter({ hasText: seededFile.fileName })
    ).toBeVisible()
    await expect
      .poll(() =>
        orcaPage.evaluate(
          async (filePath) => (await window.api.fs.readFile({ filePath })).content,
          seededFile.filePath
        )
      )
      .toBe('staged content\n')
  })
})
