import { expect, test } from '@playwright/test'
import type { TerminalTab } from '../../src/shared/workspace-layout/terminal-tab-types'

test('returns keyboard focus to the agent menu except when opening Rename', async ({ page }) => {
  await page.goto('/fixtures.html?id=sidebar/workspace-card/activity/SidebarAgentActions:closed')
  await expect(page.locator('html')).toHaveAttribute('data-fixture-state', 'ready')
  const trigger = page.getByRole('button', { name: 'Agent actions', exact: true })
  await trigger.focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('menu')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(trigger).toBeFocused()
  await page.keyboard.press('Enter')
  await page.getByRole('menuitem', { name: 'Rename…', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Name', exact: true })).toBeFocused()
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(trigger).toBeFocused()
  await page.keyboard.press('Enter')
  await page.getByRole('menuitem', { name: 'Rename…', exact: true }).click()
  await page.keyboard.press('Escape')
  await expect(trigger).toBeFocused()
  await page.keyboard.press('Enter')
  await page.getByRole('menuitem', { name: 'Rename…', exact: true }).click()
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(trigger).toBeFocused()
})

for (const owner of [true, false]) {
  test(`offers terminal continuation only for the chat-owning split (${owner})`, async ({
    page
  }) => {
    await page.goto(
      `/fixtures.html?id=sidebar/workspace-card/activity/SidebarAgentActions:${owner ? 'splitOwner' : 'splitSibling'}`
    )
    await expect(page.locator('html')).toHaveAttribute('data-fixture-state', 'ready')
    await page.getByRole('button', { name: 'Agent actions', exact: true }).click()
    const continuation = page.getByRole('menuitem', {
      name: 'Continue with Terminal Agent',
      exact: true
    })
    await (owner ? expect(continuation).toBeVisible() : expect(continuation).toHaveCount(0))
  })
}

test('preserves a custom split title that looks like a default terminal title', async ({
  page
}) => {
  await page.goto(
    '/fixtures.html?id=sidebar/workspace-card/activity/SidebarAgentActions:splitDefaultTitle'
  )
  await expect(page.locator('html')).toHaveAttribute('data-fixture-state', 'ready')
  const openRename = async () => {
    await page.getByRole('button', { name: 'Agent actions', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Rename…', exact: true }).click()
  }
  await openRename()
  await expect(page.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('Terminal 7')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await openRename()
  await expect(page.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('Terminal 7')
})

test('saving an unchanged live name lets later live titles update the row', async ({ page }) => {
  await page.goto('/fixtures.html?id=sidebar/workspace-card/activity/SidebarAgentActions:closed')
  await expect(page.locator('html')).toHaveAttribute('data-fixture-state', 'ready')
  await page.getByRole('button', { name: 'Agent actions', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Rename…', exact: true }).click()
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await page.evaluate(async () => {
    const storePath = '/src/store/index.ts'
    type Tabs = { tabsByWorktree: Record<string, TerminalTab[]> }
    const { useAppStore }: { useAppStore: { setState: (update: (state: Tabs) => Tabs) => void } } =
      await import(/* @vite-ignore */ storePath)
    useAppStore.setState((state) => ({
      tabsByWorktree: {
        ...state.tabsByWorktree,
        'fixture-workspace': state.tabsByWorktree['fixture-workspace'].map((tab) => ({
          ...tab,
          title: 'Follow-up investigation'
        }))
      }
    }))
  })
  await expect(page.getByText('Follow-up investigation', { exact: true })).toBeVisible()
})
