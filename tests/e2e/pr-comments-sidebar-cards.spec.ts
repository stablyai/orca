import type { Locator } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { openChecks } from './helpers/source-control-ai-generation'
import { seedPRCommentsSidebarFixture } from './helpers/pr-comments-sidebar-fixture'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

async function visibleTextX(card: Locator, text: string): Promise<number> {
  const textBox = await card.evaluate((element, targetText) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
    while (walker.nextNode()) {
      const node = walker.currentNode
      const value = node.textContent ?? ''
      const index = value.indexOf(targetText)
      if (index === -1) {
        continue
      }
      const range = document.createRange()
      range.setStart(node, index)
      range.setEnd(node, index + targetText.length)
      const rect = range.getBoundingClientRect()
      return { x: rect.x }
    }
    return null
  }, text)
  if (!textBox) {
    throw new Error(`visible text not found: ${text}`)
  }
  return textBox.x
}

test.describe('PR comments sidebar cards view', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
  })

  test('groups open, conversation, and resolved comments in cards layout', async ({ orcaPage }) => {
    const { worktreeId } = await seedPRCommentsSidebarFixture(orcaPage)
    await openChecks(orcaPage, worktreeId)

    const commentsSection = orcaPage.getByText('Comments', { exact: true })
    await expect(commentsSection).toBeVisible({ timeout: 10_000 })

    await expect(orcaPage.getByText('Needs review · 1')).toBeVisible()
    await expect(orcaPage.getByText('Please update this handler before merge.')).toBeVisible()
    await expect(orcaPage.getByText('alice')).toBeVisible()
    await expect(orcaPage.getByText('Open', { exact: true })).toBeVisible()
    await expect(orcaPage.getByText('LGTM on the overall approach.')).toBeVisible()

    const resolvedTrigger = orcaPage.getByRole('button', { name: 'Resolved · 1' })
    await expect(resolvedTrigger).toBeVisible()
    await expect(orcaPage.getByText('Already fixed upstream.')).toBeHidden()

    await resolvedTrigger.click()
    await expect(orcaPage.getByText('Already fixed upstream.')).toBeVisible()
    await expect(orcaPage.getByText('Resolved', { exact: true })).toBeVisible()
    await expect(orcaPage.getByRole('button', { name: 'Unresolve', exact: true })).toBeVisible()

    await expect(orcaPage.getByRole('button', { name: /^Add$/ })).toHaveCount(0)

    const openThreadCard = orcaPage.getByTestId('pr-comment-card').filter({
      hasText: 'Please update this handler before merge.'
    })
    const conversationCard = orcaPage.getByTestId('pr-comment-card').filter({
      hasText: 'LGTM on the overall approach.'
    })
    await expect(openThreadCard).toBeVisible()
    await expect(conversationCard).toBeVisible()
    await expect(openThreadCard).toHaveClass(/shadow-xs/)
    expect(
      Math.abs(
        (await visibleTextX(openThreadCard, 'Please update this handler before merge.')) -
          (await visibleTextX(conversationCard, 'LGTM on the overall approach.'))
      )
    ).toBeLessThanOrEqual(1)
    expect(
      Math.abs(
        (await visibleTextX(openThreadCard, 'alice')) -
          (await visibleTextX(conversationCard, 'bob'))
      )
    ).toBeLessThanOrEqual(1)
  })

  test('can switch from grouped to chronological timeline order', async ({ orcaPage }) => {
    const { worktreeId } = await seedPRCommentsSidebarFixture(orcaPage)
    await openChecks(orcaPage, worktreeId)

    await expect(orcaPage.getByText('Needs review · 1')).toBeVisible({ timeout: 10_000 })
    await orcaPage.getByRole('button', { name: 'Comment display options' }).click()
    await orcaPage.getByRole('menuitemradio', { name: 'Timeline' }).click()

    await expect(orcaPage.getByText('Needs review · 1')).toHaveCount(0)
    await expect(orcaPage.getByText('Already fixed upstream.')).toBeVisible()

    const comments = [
      orcaPage.getByText('Already fixed upstream.'),
      orcaPage.getByText('Please update this handler before merge.'),
      orcaPage.getByText('LGTM on the overall approach.')
    ]
    const positions = await Promise.all(
      comments.map(async (comment) => {
        const box = await comment.boundingBox()
        return box?.y ?? Number.POSITIVE_INFINITY
      })
    )

    expect(positions[0]).toBeLessThan(positions[1])
    expect(positions[1]).toBeLessThan(positions[2])
  })

  test('queues an open thread for the agent from the row menu', async ({ orcaPage }) => {
    const { worktreeId } = await seedPRCommentsSidebarFixture(orcaPage)
    await openChecks(orcaPage, worktreeId)

    await expect(orcaPage.getByText('Needs review · 1')).toBeVisible({ timeout: 10_000 })

    const openThreadCard = orcaPage.getByTestId('pr-comment-card').filter({
      hasText: 'Please update this handler before merge.'
    })
    await openThreadCard.hover()
    const firstActionsMenu = orcaPage.getByRole('button', { name: 'More comment actions' }).first()
    await firstActionsMenu.evaluate((element) => (element as HTMLElement).focus())
    await firstActionsMenu.press('Enter')
    await orcaPage.getByRole('menuitem', { name: 'Queue for agent' }).click({ force: true })

    await expect(orcaPage.getByRole('button', { name: 'Send 1 queued comments' })).toBeVisible()
    await expect(orcaPage.getByText('Queued', { exact: true })).toBeVisible()

    const queuedCard = orcaPage.getByTestId('pr-comment-card').filter({
      hasText: 'Please update this handler before merge.'
    })
    const queuedCardBox = await queuedCard.boundingBox()
    const checkboxBox = await orcaPage
      .getByRole('checkbox', { name: 'Select comment' })
      .first()
      .boundingBox()
    if (!queuedCardBox || !checkboxBox) {
      throw new Error('queued card and checkbox must be measurable')
    }
    expect(checkboxBox.x - queuedCardBox.x).toBeGreaterThanOrEqual(8)
  })

  test('keeps open card content aligned while the row menu is open', async ({ orcaPage }) => {
    const { worktreeId } = await seedPRCommentsSidebarFixture(orcaPage)
    await openChecks(orcaPage, worktreeId)

    await expect(orcaPage.getByText('Needs review · 1')).toBeVisible({ timeout: 10_000 })
    const openThreadCard = orcaPage.getByTestId('pr-comment-card').filter({
      hasText: 'Please update this handler before merge.'
    })
    const conversationCard = orcaPage.getByTestId('pr-comment-card').filter({
      hasText: 'LGTM on the overall approach.'
    })

    await openThreadCard.hover()
    const firstActionsMenu = orcaPage.getByRole('button', { name: 'More comment actions' }).first()
    await firstActionsMenu.evaluate((element) => (element as HTMLElement).focus())
    await firstActionsMenu.press('Enter')
    await expect(orcaPage.getByRole('menuitem', { name: 'Queue for agent' })).toBeVisible()

    expect(
      Math.abs(
        (await visibleTextX(openThreadCard, 'Please update this handler before merge.')) -
          (await visibleTextX(conversationCard, 'LGTM on the overall approach.'))
      )
    ).toBeLessThanOrEqual(1)
  })
})
