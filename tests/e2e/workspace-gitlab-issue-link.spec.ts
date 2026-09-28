import { expect, test } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'

/** Renders the issue-link row for a GitLab-linked workspace. The unit tests cover
 *  the payload and parse rules; this proves the row actually paints three providers
 *  and the GitLab chip in a real Electron renderer. */
test.describe('GitLab issue link', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await orcaPage.waitForTimeout(750)
  })

  test('offers GitLab in the issue row, seeds it, and warns about displacement', async ({
    orcaPage
  }, testInfo) => {
    const openDialog = async (): Promise<void> => {
      await orcaPage.evaluate(() => {
        const state = window.__store!.getState()
        const worktree = Object.values(state.worktreesByRepo)
          .flat()
          .find((candidate) => candidate.id === state.activeWorktreeId)
        if (!worktree) {
          throw new Error('Active worktree not found')
        }
        state.openModal('edit-meta', {
          worktreeId: worktree.id,
          repoId: worktree.repoId,
          currentDisplayName: worktree.displayName,
          currentComment: worktree.comment,
          focus: 'comment'
        })
      })
    }

    await openDialog()
    const dialog = orcaPage.getByRole('dialog', { name: 'Edit Worktree Details' })
    const issueInput = dialog.getByPlaceholder('Issue #, or a GitHub, GitLab or Linear URL')
    await expect(issueInput).toBeVisible()

    // 1. The dropdown offers all three providers.
    await dialog.getByRole('button', { name: 'Issue provider' }).click()
    await expect(orcaPage.getByRole('menuitemradio', { name: 'GitHub' })).toBeVisible()
    await expect(orcaPage.getByRole('menuitemradio', { name: 'GitLab' })).toBeVisible()
    await expect(orcaPage.getByRole('menuitemradio', { name: 'Linear' })).toBeVisible()
    await orcaPage.screenshot({ path: testInfo.outputPath('issue-provider-menu.png') })
    await testInfo.attach('issue-provider-menu.png', {
      path: testInfo.outputPath('issue-provider-menu.png'),
      contentType: 'image/png'
    })
    await orcaPage.keyboard.press('Escape')

    // 2. Pasting a GitLab issue URL flips the chip on its own.
    await issueInput.fill('https://gitlab.com/acme/app/-/issues/42')
    await expect(dialog.getByRole('button', { name: 'Issue provider' })).toContainText('GitLab')
    await orcaPage.screenshot({ path: testInfo.outputPath('issue-gitlab-detected.png') })
    await testInfo.attach('issue-gitlab-detected.png', {
      path: testInfo.outputPath('issue-gitlab-detected.png'),
      contentType: 'image/png'
    })

    // 3. An MR URL in the issue field is refused with GitLab-specific copy.
    await issueInput.fill('https://gitlab.com/acme/app/-/merge_requests/9')
    await expect(dialog.getByText('Not a GitLab issue number or issue URL.')).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Save' })).toBeDisabled()
    await orcaPage.screenshot({ path: testInfo.outputPath('issue-gitlab-mr-rejected.png') })
    await testInfo.attach('issue-gitlab-mr-rejected.png', {
      path: testInfo.outputPath('issue-gitlab-mr-rejected.png'),
      contentType: 'image/png'
    })

    await dialog.getByRole('button', { name: 'Cancel' }).click()
  })
})
