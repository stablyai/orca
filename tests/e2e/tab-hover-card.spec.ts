import { expect, test } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { startHiddenRendererFrameCapture } from './helpers/hidden-renderer-frame-capture'

test('whole-tab hover cards wait independently on every hover', async ({
  electronApp,
  orcaPage
}) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await orcaPage.evaluate(() => {
    const s = window.__store?.getState()
    const worktreeId = s?.activeWorktreeId
    if (!s || !worktreeId) {
      throw new Error('Missing workspace')
    }
    const first = s.tabsByWorktree[worktreeId]?.[0]
    if (!first) {
      throw new Error('Missing terminal tab')
    }
    s.setTabCustomTitle(first.id, 'Build and test the hover cards')
    const second = s.createTab(worktreeId)
    s.setTabCustomTitle(second.id, 'Review changes')
  })
  const browserWindow = await electronApp.browserWindow(orcaPage)
  await browserWindow.evaluate((window) => window.webContents.setBackgroundThrottling(false))
  await browserWindow.dispose()
  const stopCapture = await startHiddenRendererFrameCapture(orcaPage)
  try {
    const first = orcaPage.locator('[data-testid="sortable-tab"]').first()
    const second = orcaPage.locator('[data-testid="sortable-tab"]').nth(1)
    const firstBox = await first.boundingBox()
    const secondBox = await second.boundingBox()
    if (!firstBox || !secondBox) {
      throw new Error('Missing tab bounds')
    }
    const card = orcaPage.locator('[data-tab-hover-card]')
    const cardTitle = card.locator('[data-tab-hover-card-title]')

    // The left padding and icon used to sit outside the terminal title's trigger.
    await orcaPage.mouse.move(firstBox.x + 3, firstBox.y + firstBox.height / 2)
    await orcaPage.waitForTimeout(300)
    await expect(card).toHaveCount(0)
    await expect(cardTitle).toHaveText('Build and test the hover cards')
    const program = card.locator('[data-tab-hover-card-program]')
    await expect(program.locator('[data-shell-icon]')).toHaveCount(1)
    await expect(program).toHaveText('Terminal')
    const titleBox = await cardTitle.boundingBox()
    const programBox = await program.boundingBox()
    expect(programBox?.y).toBeGreaterThan((titleBox?.y ?? 0) + (titleBox?.height ?? 0))
    await orcaPage.mouse.move(secondBox.x + 3, secondBox.y + secondBox.height / 2)
    await orcaPage.waitForTimeout(300)
    await expect(card).toHaveCount(0)
    await expect(cardTitle).toHaveText('Review changes')

    // Leaving cancels a pending preview; time spent on other tabs does not count.
    await orcaPage.mouse.move(firstBox.x + 3, firstBox.y + firstBox.height / 2)
    await orcaPage.waitForTimeout(300)
    await orcaPage.mouse.move(secondBox.x + 3, secondBox.y + secondBox.height / 2)
    await orcaPage.waitForTimeout(300)
    await orcaPage.mouse.move(secondBox.x + 3, secondBox.y + secondBox.height + 100)
    await orcaPage.waitForTimeout(900)
    await expect(card).toHaveCount(0)

    await orcaPage.mouse.move(firstBox.x + 3, firstBox.y + firstBox.height / 2)
    await orcaPage.waitForTimeout(300)
    await expect(card).toHaveCount(0)
    await expect(cardTitle).toHaveText('Build and test the hover cards')

    // Re-entering the same tab also requires a fresh dwell.
    await orcaPage.mouse.move(firstBox.x + 3, firstBox.y + firstBox.height + 100)
    await expect(card).toHaveCount(0)
    await orcaPage.mouse.move(firstBox.x + 3, firstBox.y + firstBox.height / 2)
    await orcaPage.waitForTimeout(300)
    await expect(card).toHaveCount(0)
    await expect(cardTitle).toHaveText('Build and test the hover cards')

    await first.locator('[data-tab-close-button]').hover()
    await orcaPage.waitForTimeout(100)
    await expect(cardTitle).toHaveText('Build and test the hover cards')
    await expect(card).toHaveCount(1)
    await expect(orcaPage.locator('[data-tab-close-tooltip]')).toHaveCount(0)
    await orcaPage.waitForTimeout(500)
    await expect(cardTitle).toHaveText('Build and test the hover cards')
    await expect(card).toHaveCount(1)
    await expect(orcaPage.locator('[data-tab-close-tooltip]')).toHaveCount(0)
    await orcaPage.mouse.move(secondBox.x + 3, secondBox.y + secondBox.height / 2)
    await expect(cardTitle).toHaveText('Review changes')

    await orcaPage.emulateMedia({ reducedMotion: 'reduce' })
    await orcaPage.mouse.move(firstBox.x + 3, firstBox.y + firstBox.height / 2)
    await expect(cardTitle).toHaveText('Build and test the hover cards')
    expect(await card.evaluate((element) => element.getAnimations().length)).toBe(0)
    await first.locator('[data-tab-close-button]').focus()
    await expect(orcaPage.locator('[data-tab-close-tooltip]')).toHaveCount(0)
    await expect(card).toHaveCount(1)
    await orcaPage.mouse.move(firstBox.x + 3, firstBox.y + firstBox.height + 100)
    await expect(card).toHaveCount(0)
    await first.focus()
    await expect(cardTitle).toHaveText('Build and test the hover cards', { timeout: 150 })
    await expect(orcaPage.locator('[data-tab-close-tooltip]')).toHaveCount(0)
    await first.press('Escape')
    await expect(card).toHaveCount(0)

    await first.click({ position: { x: 3, y: firstBox.height / 2 } })
    await expect(card).toHaveCount(0)

    await orcaPage.mouse.move(firstBox.x + 3, firstBox.y + firstBox.height + 100)
    await orcaPage.waitForTimeout(400)
    await orcaPage.mouse.move(secondBox.x + 3, secondBox.y + secondBox.height / 2)
    await orcaPage.waitForTimeout(200)
    await expect(card).toHaveCount(0)
    await expect(cardTitle).toHaveText('Review changes')
  } finally {
    await stopCapture()
  }
})
