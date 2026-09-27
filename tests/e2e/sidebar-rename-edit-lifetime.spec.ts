import { test, expect } from './sidebar-animation-fixture'
import { prepareRenameTyping } from './sidebar-rename-readiness-state'
import { worktreeRow } from './worktree-row-locators'

for (const targetId of ['e2e-virtual-child-400', 'ordinary-60']) {
  test(`rename draft survives scrolling and churn: ${targetId}`, async ({ orcaPage }) => {
    await prepareRenameTyping(orcaPage, targetId)
    await orcaPage.keyboard.press('ControlOrMeta+Alt+r')
    await orcaPage.waitForTimeout(60)
    await orcaPage.keyboard.type('draft')
    const input = worktreeRow(orcaPage, targetId).getByRole('textbox')
    await expect(input).toHaveValue('draft')
    const original = await input.elementHandle()
    await expect
      .poll(() => orcaPage.evaluate(() => window.__store!.getState().pendingRevealWorktree))
      .toBeNull()
    await orcaPage.evaluate(() => {
      const store = window.__store!
      store.setState((state) => ({
        worktreesByRepo: Object.fromEntries(
          Object.entries(state.worktreesByRepo).map(([id, rows]) => [
            id,
            rows.map((row) => ({ ...row, isUnread: !row.isUnread }))
          ])
        )
      }))
      const scroller = document.querySelector<HTMLElement>('[data-worktree-sidebar]')!
      scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: -200, bubbles: true }))
      scroller.scrollTo({ top: 0, behavior: 'instant' })
    })
    await orcaPage.waitForTimeout(650)
    expect(await original!.evaluate((node) => node.isConnected)).toBe(true)
    await expect(input).toHaveValue('draft')
    await expect(input).toBeFocused()
    await orcaPage.keyboard.press('ArrowLeft')
    await orcaPage.keyboard.type(' ')
    await expect(input).toHaveValue('draf t')
    await orcaPage.keyboard.press('Escape')
    await expect(input).toHaveCount(0)
    await expect(orcaPage.locator('#rename-typing-terminal')).toHaveValue('')
  })
}

for (const reducedMotion of ['reduce', 'no-preference'] as const) {
  for (const key of ['Escape', 'Enter']) {
    test(`rename ${key} during reveal stays consumed: ${reducedMotion}`, async ({ orcaPage }) => {
      const targetId = 'e2e-virtual-child-400'
      await prepareRenameTyping(orcaPage, targetId, reducedMotion)
      await orcaPage.keyboard.press('ControlOrMeta+Alt+r')
      await orcaPage.waitForTimeout(60)
      const input = worktreeRow(orcaPage, targetId).getByRole('textbox')
      await expect(input).toBeFocused()
      // Unchanged Enter closes without a fixture-only workspace persistence request.
      await orcaPage.keyboard.press(key)
      await expect(input).toHaveCount(0)
      await expect
        .poll(() => orcaPage.evaluate(() => window.__store!.getState().pendingRevealWorktree))
        .toBeNull()
      await orcaPage.waitForTimeout(300)
      await expect(input).toHaveCount(0)
    })
  }
}

test('rename remains visible after reentrant wheel intent before input mount', async ({
  orcaPage
}) => {
  const targetId = 'e2e-virtual-child-400'
  await prepareRenameTyping(orcaPage, targetId)
  const subscription = await orcaPage.evaluateHandle(() => {
    const store = window.__store!
    const unsubscribe = store.subscribe((state) => {
      if (state.renamingWorktreeId) {
        unsubscribe()
        const scroller = document.querySelector<HTMLElement>('[data-worktree-sidebar]')!
        scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: 60, bubbles: true }))
      }
    })
    return { unsubscribe }
  })
  try {
    await orcaPage.keyboard.press('ControlOrMeta+Alt+r')
    const input = worktreeRow(orcaPage, targetId).getByRole('textbox')
    await expect(input).toBeFocused()
    await expect(input).toBeInViewport()
    await orcaPage.keyboard.type('draft')
    await expect(input).toHaveValue('draft')
  } finally {
    await subscription.evaluate((value) => value.unsubscribe())
    await subscription.dispose()
  }
})
