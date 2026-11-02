// Completed tab and composer actions return keyboard input to the chat draft.

import type { Locator } from '@stablyai/playwright-test'
import { expect } from './helpers/orca-app'
import { SUPPORTED, openStubChat, test } from './helpers/structured-claude-stub'

function focusIsIn(composer: Locator): Promise<boolean> {
  return composer.evaluate((element) => element.contains(element.ownerDocument.activeElement))
}

test.describe('native chat composer focus', () => {
  test.skip(!SUPPORTED, 'the Claude stub wrapper is POSIX-only')

  test('keyboard tab rename returns input to the native chat composer', async ({
    orcaPage: page,
    claudeStub
  }) => {
    const { tab, composer } = await openStubChat(page, claudeStub.command)
    await tab.dblclick()
    const rename = tab.locator('[data-tab-rename-input="true"]')
    await expect(rename).toBeFocused()
    await rename.fill('')
    await rename.pressSequentially('Renamed chat', { delay: 60 })
    await page.keyboard.press('Enter')
    await expect(rename).toHaveCount(0)
    await expect(tab).toHaveAttribute('data-tab-title', 'Renamed chat')
    await expect.poll(() => focusIsIn(composer)).toBe(true)
    await page.keyboard.type('Draft after rename')
    await expect(composer).toContainText('Draft after rename')
  })

  test('when Send disables at the end of the turn', async ({ orcaPage: page, claudeStub }) => {
    const { composer, send, stop, reply } = await openStubChat(page, claudeStub.command)
    await page.keyboard.type('hello')
    await send.click()
    await expect(reply).toBeVisible({ timeout: 30_000 })
    await expect(stop).toHaveCount(0)
    await expect.poll(() => focusIsIn(composer)).toBe(true)
  })

  test('when Stop disables while the stop is in flight', async ({ orcaPage: page, claudeStub }) => {
    const { composer, send, stop } = await openStubChat(page, claudeStub.command)
    // The stub runs a prompt containing "slow" until it is interrupted.
    await page.keyboard.type('slow')
    await send.click()
    await stop.click()
    await expect(stop).toHaveCount(0, { timeout: 30_000 })
    await expect.poll(() => focusIsIn(composer)).toBe(true)
  })
})
