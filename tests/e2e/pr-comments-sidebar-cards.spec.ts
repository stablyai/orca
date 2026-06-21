import { test, expect } from './helpers/orca-app'
import { openChecks } from './helpers/source-control-ai-generation'
import { seedPRCommentsSidebarFixture } from './helpers/pr-comments-sidebar-fixture'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

test.describe('PR comments sidebar cards view', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
  })

  test('triages open, conversation, and resolved comments in cards layout', async ({
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

    const resolvedTrigger = orcaPage.getByRole('button', { name: 'Resolved · 1' })
    await expect(resolvedTrigger).toBeVisible()
    await expect(orcaPage.getByText('Already fixed upstream.')).toBeHidden()

    await resolvedTrigger.click()
    await expect(orcaPage.getByText('Already fixed upstream.')).toBeVisible()
    await expect(orcaPage.getByText('Resolved', { exact: true })).toBeVisible()
    await expect(orcaPage.getByRole('button', { name: 'Unresolve' })).toBeVisible()

    await expect(orcaPage.getByRole('button', { name: /^Add$/ })).toHaveCount(0)

    const openThreadCard = orcaPage
      .getByText('Please update this handler before merge.')
      .locator('xpath=ancestor::*[contains(@class,"rounded-lg")][1]')
    await expect(openThreadCard).toBeVisible()
    await expect(openThreadCard).toHaveClass(/shadow-xs/)
  })

  test('queues an open thread for the agent from the row menu', async ({ orcaPage }) => {
    const { worktreeId } = await seedPRCommentsSidebarFixture(orcaPage)
    await openChecks(orcaPage, worktreeId)

    await expect(orcaPage.getByText('Needs review · 1')).toBeVisible({ timeout: 10_000 })

    await orcaPage.getByRole('button', { name: 'More comment actions' }).first().click()
    await orcaPage.getByRole('menuitem', { name: 'Queue for agent' }).click()

    await expect(orcaPage.getByRole('button', { name: 'Send 1 queued comments' })).toBeVisible()
    await expect(orcaPage.getByText('Queued', { exact: true })).toBeVisible()
  })
})
