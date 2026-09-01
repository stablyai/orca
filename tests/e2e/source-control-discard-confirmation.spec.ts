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
  await page.getByTestId('source-control-filter-toggle').click()
  await expect(page.getByPlaceholder(/Filter files/)).toBeVisible()
}

async function seedUntrackedFile(
  page: Page,
  requestedFileName?: string
): Promise<SeededUntrackedFile> {
  return page.evaluate(async (requestedFileName) => {
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
    const fileName = requestedFileName ?? `orca-discard-confirm-${Date.now()}.txt`
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
  }, requestedFileName)
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

async function expectDeleteDialogLayout(page: Page, fileName: string): Promise<void> {
  const dialog = page.getByRole('dialog', { name: `Delete "${fileName}"?` })
  await expect(dialog).toBeVisible()
  await expect
    .poll(
      async () =>
        dialog.evaluate((element) => {
          const panel = element.getBoundingClientRect()
          const title = element.querySelector<HTMLElement>('[data-slot="dialog-title"]')
          const footer = element.querySelector<HTMLElement>('[data-slot="dialog-footer"]')
          if (!title || !footer) {
            return false
          }
          const titleRect = title.getBoundingClientRect()
          const footerRect = footer.getBoundingClientRect()
          const lineHeight = Number.parseFloat(getComputedStyle(title).lineHeight) || 16
          const buttonsFit = [...footer.querySelectorAll<HTMLElement>('button')].every((button) => {
            const rect = button.getBoundingClientRect()
            return rect.left >= panel.left && rect.right <= panel.right
          })
          return (
            titleRect.height > lineHeight * 1.5 &&
            titleRect.left >= panel.left &&
            titleRect.right <= panel.right &&
            footerRect.left >= panel.left &&
            footerRect.right <= panel.right &&
            buttonsFit &&
            element.scrollWidth <= element.clientWidth
          )
        }),
      { timeout: 5_000, message: 'long delete-dialog title or footer escaped the panel' }
    )
    .toBe(true)
}

test.describe('Source Control discard confirmation', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
  })

  test('keeps long untracked-file confirmation usable and deletes on confirm', async ({
    orcaPage
  }) => {
    const seededFile = await seedUntrackedFile(
      orcaPage,
      `orca-discard-confirm-${'x'.repeat(96)}.txt`
    )
    await openSourceControl(orcaPage)

    const row = orcaPage
      .locator('[data-testid="source-control-entry"]')
      .filter({ hasText: seededFile.fileName })
    await expect(row).toBeVisible()

    await deleteUntrackedFileFromRow(row)
    await expectDeleteDialogLayout(orcaPage, seededFile.fileName)

    await orcaPage.getByRole('button', { name: 'Cancel' }).click()
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
})
