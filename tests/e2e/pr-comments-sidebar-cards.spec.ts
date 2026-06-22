import { test, expect } from './helpers/orca-app'
import { openChecks } from './helpers/source-control-ai-generation'
import { seedPRCommentsSidebarFixture } from './helpers/pr-comments-sidebar-fixture'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

test.describe('PR comments sidebar cards view', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
  })

  test('triages comments in cards layout and queues open threads from the row menu', async ({
    orcaPage
  }) => {
    const { worktreeId } = await seedPRCommentsSidebarFixture(orcaPage)
    await openChecks(orcaPage, worktreeId)

    const commentsSection = orcaPage.getByText('Comments', { exact: true })
    await expect(commentsSection).toBeVisible({ timeout: 10_000 })

    await expect(orcaPage.getByText('Needs review · 1')).toBeVisible()
    await expect(orcaPage.getByText('Please update this handler before merge.')).toBeVisible()
    await expect(orcaPage.getByText('Open', { exact: true })).toBeVisible()
    await expect(orcaPage.getByText('LGTM on the overall approach.')).toBeVisible()

    const openThreadCard = orcaPage.getByTestId('pr-comment-group').filter({
      hasText: 'Please update this handler before merge.'
    })
    await expect(openThreadCard).toBeVisible()
    await expect(openThreadCard).toHaveClass(/shadow-xs/)

    await openThreadCard.getByRole('button', { name: 'More comment actions' }).click()
    await orcaPage
      .locator('[role="menu"]')
      .last()
      .getByRole('menuitem', { name: 'Queue for agent' })
      .click()

    await expect(orcaPage.getByRole('button', { name: 'Send 1 queued comments' })).toBeVisible()
    await expect(orcaPage.getByText('Queued', { exact: true })).toBeVisible()

    const resolvedTrigger = orcaPage.getByRole('button', { name: 'Resolved · 1' })
    await expect(resolvedTrigger).toBeVisible()
    await expect(orcaPage.getByText('Already fixed upstream.')).toBeHidden()

    await resolvedTrigger.click()
    await expect(orcaPage.getByText('Already fixed upstream.')).toBeVisible()
    await expect(orcaPage.getByText('Resolved', { exact: true })).toBeVisible()
    await expect(
      orcaPage
        .getByTestId('pr-comment-group')
        .filter({ hasText: 'Already fixed upstream.' })
        .getByRole('button', { name: 'Unresolve', exact: true })
    ).toBeVisible()

    await expect(orcaPage.getByRole('button', { name: /^Add$/ })).toHaveCount(0)
  })
})
