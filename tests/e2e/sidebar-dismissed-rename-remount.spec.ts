import { test, expect } from './sidebar-animation-fixture'
import { prepareRenameTyping } from './sidebar-rename-readiness-state'
import { worktreeRow } from './worktree-row-locators'

const dismissals = ['Escape', 'Enter'] as const
const lifetimes = ['close-open', 'body-switch', 'no-unmount'] as const

for (const dismissal of dismissals) {
  for (const lifetime of lifetimes) {
    test(`${dismissal} rename dismissal stays closed through ${lifetime}`, async ({ orcaPage }) => {
      const targetId = 'e2e-virtual-child-400'
      await prepareRenameTyping(orcaPage, targetId, 'no-preference')
      await orcaPage.keyboard.press('ControlOrMeta+Alt+r')
      const row = worktreeRow(orcaPage, targetId)
      const input = row.getByRole('textbox')
      await expect(input).toBeFocused()
      const pending = () =>
        orcaPage.evaluate(
          () => window.__store!.getState().pendingRevealWorktree?.worktreeId ?? null
        )
      await expect.poll(pending).toBe(targetId)
      await orcaPage.keyboard.press(dismissal)
      await expect(input).toHaveCount(0)
      await expect.poll(pending).toBe(targetId)

      if (lifetime === 'close-open') {
        await orcaPage.evaluate(() => window.__store!.getState().setSidebarOpen(false))
        await expect(orcaPage.locator('[data-worktree-sidebar]')).toHaveCount(0)
        await orcaPage.evaluate(() => window.__store!.getState().setSidebarOpen(true))
      } else if (lifetime === 'body-switch') {
        await orcaPage.evaluate(() => window.__store!.getState().setSidebarBody('agents'))
        await expect(orcaPage.locator('[data-worktree-sidebar]')).toHaveCount(0)
        await orcaPage.evaluate(() => window.__store!.getState().setSidebarBody('workspaces'))
      }

      await expect(input).toHaveCount(0)
      await orcaPage.waitForTimeout(1_600)
      await expect(input).toHaveCount(0)
      await expect.poll(pending, { timeout: 10_000 }).toBeNull()

      await orcaPage.evaluate((worktreeId) => {
        window.__store!.getState().revealWorktreeInSidebar(worktreeId, {
          behavior: 'auto',
          highlight: false,
          beginRename: true
        })
      }, targetId)
      await expect(input).toBeVisible()
      await expect(input).toBeFocused()
    })
  }
}
