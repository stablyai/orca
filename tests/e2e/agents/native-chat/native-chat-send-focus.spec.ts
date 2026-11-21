// Completed tab and composer actions return keyboard input to the chat draft.

import type { Locator } from '@stablyai/playwright-test'
import '../../desktop/electron-fixtures/orca-app'
import { expect } from '@stablyai/playwright-test'
import { SUPPORTED, openStubChat, test } from '../session-fixtures/structured-claude-stub'

function focusIsIn(composer: Locator): Promise<boolean> {
  return composer.evaluate((element) => element.contains(element.ownerDocument.activeElement))
}

test.describe('native chat composer focus', () => {
  test.skip(!SUPPORTED, 'the Claude stub wrapper is POSIX-only')

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
