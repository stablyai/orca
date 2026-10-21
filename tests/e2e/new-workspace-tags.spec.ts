import { openSidebarWorkspaceComposer } from './helpers/sidebar-project-dialog'
import { test, expect } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { worktreeRow } from './worktree-row-locators'

test.use({ orcaAppExtraEnv: { ORCA_BACKGROUND_LAUNCH: '1' } })

test('tags chosen in the create form land on the new workspace', async ({ orcaPage }) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await orcaPage.evaluate(() => {
    const store = window.__store!
    const state = store.getState()
    store.setState({ settings: { ...state.settings!, defaultTuiAgent: 'blank' } })
  })

  await openSidebarWorkspaceComposer(orcaPage)
  const dialog = orcaPage.getByRole('dialog', { name: /Create (Workspace|Worktree)/i })
  await dialog.locator('[data-workspace-name-input="true"]').fill('tagged-from-composer')
  await dialog.getByRole('button', { name: 'Advanced' }).click()

  // Why type key by key: Space and Enter are exactly the keys the composer could swallow.
  const tagsInput = dialog.getByRole('textbox', { name: 'Tags' })
  await tagsInput.pressSequentially('billing team')
  await tagsInput.press('Enter')
  await expect(dialog.getByRole('button', { name: 'Remove tag billing team' })).toBeVisible()
  // Enter committed the tag instead of creating the workspace.
  await expect(dialog).toBeVisible()

  await dialog.getByRole('button', { name: /^Create/ }).click()

  let created: string | null = null
  await expect
    .poll(async () => {
      created = await orcaPage.evaluate(
        () =>
          window
            .__store!.getState()
            .allWorktrees()
            .find((entry) => entry.displayName === 'tagged-from-composer')?.id ?? null
      )
      return created
    })
    .not.toBeNull()
  await expect(worktreeRow(orcaPage, created!).getByLabel('Tags', { exact: true })).toContainText(
    'billing team'
  )
})
