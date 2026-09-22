import { expect, type Page } from '@stablyai/playwright-test'

export async function expectSidebarProjectVisible(page: Page, projectName: string): Promise<void> {
  const sidebar = page.getByRole('listbox', { name: 'Worktrees', exact: true })
  const label = sidebar.getByText(projectName, { exact: false }).first()
  await sidebar.evaluate((element) => {
    element.scrollTop = 0
    element.dispatchEvent(new Event('scroll', { bubbles: true }))
  })
  await expect
    .poll(
      async () => {
        if (await label.isVisible()) {
          return true
        }
        // Virtualized project headers mount only as their scroll range enters the viewport.
        await sidebar.evaluate((element) => {
          element.scrollTop += Math.max(1, Math.floor(element.clientHeight * 0.8))
          element.dispatchEvent(new Event('scroll', { bubbles: true }))
        })
        return false
      },
      { message: `sidebar never rendered project ${projectName}`, intervals: [100] }
    )
    .toBe(true)
  await expect(label).toBeVisible()
}
