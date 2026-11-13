// A focused notice summary keeps Space and Enter; other typing still reaches the chat draft.

import { expect } from './helpers/orca-app'
import { SUPPORTED, openStubChat, test } from './helpers/structured-claude-stub'

test.describe('native chat notice keyboard', () => {
  test.skip(!SUPPORTED, 'the Claude stub wrapper is POSIX-only')

  test('Space and Enter toggle a retry notice instead of typing into the composer', async ({
    orcaPage: page,
    claudeStub
  }) => {
    const { composer, send, reply } = await openStubChat(page, claudeStub.command)
    // The stub reports a retried API request before replying to a prompt containing "api-retry".
    await page.keyboard.type('api-retry check')
    await expect(composer).toHaveText('api-retry check')
    await send.click()
    await expect(reply).toBeVisible({ timeout: 30_000 })
    await expect(composer).toHaveText('')

    const chat = page.locator('[data-native-chat-root="true"]')
    // The settled turn keeps its retry inside the turn's work details.
    await chat.getByRole('button', { name: 'Toggle turn details' }).click()
    const summary = chat.locator('summary', { hasText: 'Retrying (1 of 10)' })
    await expect(summary).toBeVisible()
    await summary.focus()
    await expect(summary).toHaveAttribute('aria-expanded', 'false')

    await page.keyboard.press('Space')
    await expect(summary).toHaveAttribute('aria-expanded', 'true')
    await expect(summary).toBeFocused()
    await expect(composer).toHaveText('')

    await page.keyboard.press('Enter')
    await expect(summary).toHaveAttribute('aria-expanded', 'false')
    await expect(summary).toBeFocused()
    await expect(composer).toHaveText('')

    await page.keyboard.press('Space')
    await expect(summary).toHaveAttribute('aria-expanded', 'true')
    await expect(composer).toHaveText('')

    // A letter typed on the summary still moves to the draft, and the draft keeps its spaces.
    await page.keyboard.type('Draft')
    await expect(composer).toHaveText('Draft')
    await page.keyboard.type(' with spaces')
    await expect(composer).toHaveText('Draft with spaces')
    await expect(summary).toHaveAttribute('aria-expanded', 'true')
  })
})
