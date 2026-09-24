import type { Locator, Page } from '@stablyai/playwright-test'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { test, expect } from './helpers/orca-app'
import { getAllWorktreeIds, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { worktreeRow } from './worktree-row-locators'

async function captureEvidence(page: Page, name: string, locator?: Locator): Promise<void> {
  if (process.env.ORCA_CAPTURE_EVIDENCE !== '1') {
    return
  }
  const outputDir = resolve(process.cwd(), 'pr-evidence')
  mkdirSync(outputDir, { recursive: true })
  const path = resolve(outputDir, name)
  await (locator ?? page).screenshot({ path })
}

async function openTagsSubmenu(page: Page, worktreeId: string): Promise<void> {
  await worktreeRow(page, worktreeId).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Tags' }).click()
}

function sidebarHeader(page: Page, label: string): Locator {
  return page
    .locator('[data-worktree-sidebar]')
    .getByRole('button', { name: `Tag actions for ${label}`, exact: true })
}

// Why focus + Enter: the header action collapses to zero width until the header is hovered or focused.
async function openHeaderMenu(page: Page, label: string): Promise<void> {
  const trigger = sidebarHeader(page, label)
  await trigger.focus()
  await page.keyboard.press('Enter')
}

test.describe('Sidebar tag grouping', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
  })

  test('tags workspaces from the context menu and groups, renames, and deletes by tag', async ({
    orcaPage
  }) => {
    const [firstId, secondId] = await getAllWorktreeIds(orcaPage)
    expect(secondId).toBeDefined()

    // Create a new tag on the first workspace.
    await openTagsSubmenu(orcaPage, firstId)
    const search = orcaPage.getByRole('textbox', { name: 'Find or create a tag…' })
    await search.fill('billing')
    await expect(orcaPage.getByRole('menuitem', { name: 'Create “billing”' })).toBeVisible()
    await search.press('Enter')
    await expect(orcaPage.getByRole('menuitemcheckbox', { name: 'billing' })).toBeChecked()
    await captureEvidence(orcaPage, 'tag-submenu-created.png')
    await orcaPage.keyboard.press('Escape')
    await orcaPage.keyboard.press('Escape')

    // Reuse the existing tag on the second workspace.
    await openTagsSubmenu(orcaPage, secondId)
    const existing = orcaPage.getByRole('menuitemcheckbox', { name: 'billing' })
    await expect(existing).not.toBeChecked()
    await existing.click()
    await expect(existing).toBeChecked()
    await orcaPage.keyboard.press('Escape')
    await orcaPage.keyboard.press('Escape')

    // Cards show their tags as chips, and the Tags card property hides them.
    const chips = worktreeRow(orcaPage, firstId).getByLabel('Tags', { exact: true })
    await expect(chips).toContainText('billing')
    await orcaPage.evaluate(() => {
      const state = window.__store!.getState()
      state.setWorktreeCardProperties(
        state.worktreeCardProperties.filter((property) => property !== 'tags')
      )
    })
    await expect(chips).toHaveCount(0)
    await orcaPage.evaluate(() => {
      const state = window.__store!.getState()
      state.setWorktreeCardProperties([...state.worktreeCardProperties, 'tags'])
    })
    await expect(chips).toContainText('billing')

    await orcaPage.evaluate(() => window.__store!.getState().setGroupBy('tag'))
    await expect(sidebarHeader(orcaPage, 'billing')).toBeAttached()
    await expect(worktreeRow(orcaPage, firstId)).toBeVisible()
    await expect(worktreeRow(orcaPage, secondId)).toBeVisible()
    await captureEvidence(
      orcaPage,
      'tag-grouped-sidebar.png',
      orcaPage.locator('[data-worktree-sidebar]').first()
    )

    // Rename from the section header; both workspaces follow.
    await openHeaderMenu(orcaPage, 'billing')
    await orcaPage.getByRole('menuitem', { name: 'Rename tag' }).click()
    const nameField = orcaPage.getByRole('textbox', { name: 'Tag Name' })
    await nameField.fill('Payments')
    await orcaPage.getByRole('button', { name: 'Rename' }).click()
    await expect(sidebarHeader(orcaPage, 'Payments')).toBeAttached()
    await expect(sidebarHeader(orcaPage, 'billing')).toHaveCount(0)

    // Delete removes it everywhere; the workspaces survive as untagged.
    await openHeaderMenu(orcaPage, 'Payments')
    await orcaPage.getByRole('menuitem', { name: 'Delete tag' }).click()
    await expect(
      orcaPage.getByText('The tag is removed from 2 workspace(s).', { exact: false })
    ).toBeVisible()
    await orcaPage.getByRole('button', { name: 'Delete tag' }).click()
    await expect(sidebarHeader(orcaPage, 'Payments')).toHaveCount(0)
    await expect(worktreeRow(orcaPage, firstId)).toBeVisible()

    await openTagsSubmenu(orcaPage, firstId)
    await expect(orcaPage.getByRole('menuitemcheckbox')).toHaveCount(0)
    await expect(orcaPage.getByText('Type a name to create the first tag')).toBeVisible()
  })
})
