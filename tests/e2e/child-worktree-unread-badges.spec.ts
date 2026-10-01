import { test, expect } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { seedLineageScenario, seedWorkspaceAgentStatus } from './worktree-lineage-state'
import { worktreeRow } from './worktree-row-locators'

async function setChildUnreadPreference(
  page: Parameters<typeof waitForSessionReady>[0],
  enabled: boolean
): Promise<void> {
  await page.evaluate(async (showChildWorktreeUnread) => {
    const state = window.__store!.getState()
    if (!state.settings) {
      throw new Error('Settings are not hydrated')
    }
    await state.updateSettings({
      notifications: { ...state.settings.notifications, showChildWorktreeUnread }
    })
  }, enabled)
}

for (const newCardStyle of [false, true]) {
  test(`filters child unread chrome without clearing unread or hiding activity (${newCardStyle ? 'new' : 'legacy'} cards)`, async ({
    orcaPage
  }, testInfo) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    const { parentId, childId } = await seedLineageScenario(orcaPage)
    const parent = worktreeRow(orcaPage, parentId)
    const child = worktreeRow(orcaPage, childId)
    await parent.click()
    await orcaPage.evaluate(
      async ({ childId, newCardStyle }) => {
        const state = window.__store!.getState()
        if (!state.worktreeCardProperties.includes('status')) {
          state.toggleWorktreeCardProperty('status')
        }
        await state.updateSettings({ experimentalNewWorktreeCardStyle: newCardStyle })
        state.markWorktreeUnread(childId)
      },
      { childId, newCardStyle }
    )
    const unreadIndicator = newCardStyle
      ? child.locator('[data-worktree-unread-alert]')
      : child.getByRole('button', { name: 'Mark as read', exact: true })
    await expect(unreadIndicator).toBeVisible()
    await parent.screenshot({ path: testInfo.outputPath('child-unread-on.png') })

    await setChildUnreadPreference(orcaPage, false)
    await expect(child.getByRole('button', { name: 'Mark as read', exact: true })).toHaveCount(0)
    await expect(child.locator('[data-worktree-unread-alert]')).toHaveCount(0)
    await parent.screenshot({ path: testInfo.outputPath('child-unread-off.png') })
    await parent.getByRole('button', { name: 'Hide 1 child workspace' }).click()
    const chip = parent.getByRole('button', { name: 'Show 1 child workspace' })
    await expect(chip.locator('[data-lineage-hidden-unread]')).toHaveCount(0)
    await expect(chip).not.toHaveAccessibleDescription(/unread/)

    await seedWorkspaceAgentStatus(orcaPage, childId, 'UNREAD_POLICY')
    await expect(chip).toHaveAccessibleDescription('1 working')
    await expect(chip.locator('[data-agent-spinner]')).toBeVisible()
    await parent.screenshot({ path: testInfo.outputPath('child-unread-off-working.png') })
    await setChildUnreadPreference(orcaPage, true)
    await expect(chip.locator('[data-lineage-hidden-unread]')).toBeVisible()
    await expect(chip).toHaveAccessibleDescription('1 working · 1 unread')
    await parent.screenshot({ path: testInfo.outputPath('child-unread-restored.png') })
  })
}
