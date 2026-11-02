// A Claude plugin's status line and toasts never reach the chat transcript as raw provider rows.

import { expect } from './helpers/orca-app'
import { SUPPORTED, openStubChat, test } from './helpers/structured-claude-stub'

test.describe('native chat plugin UI frames', () => {
  test.skip(!SUPPORTED, 'the Claude stub wrapper is POSIX-only')

  test('a turn with plugin status and toast frames shows only the reply', async ({
    orcaPage: page,
    claudeStub
  }) => {
    const { reply } = await openStubChat(page, claudeStub.command)
    await page.keyboard.type('plugin-ui probe')
    await page.keyboard.press('Enter')
    await expect(reply).toBeVisible({ timeout: 30_000 })
    const chat = page.locator('[data-native-chat-root="true"]')
    // Unknown frames land inside the turn's work section, so open it before looking.
    await chat.getByText(/Worked for/).click()
    await expect(chat.getByText('PR 6 · 13 open', { exact: false })).toHaveCount(0)
    await expect(chat.getByText('Board synced')).toHaveCount(0)
    await expect(reply).toBeVisible()
  })
})
