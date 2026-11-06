// A Claude plugin's status line and toasts never reach the chat transcript as raw provider rows.

import { readFileSync } from 'node:fs'
import { expect } from './helpers/orca-app'
import { SUPPORTED, openStubChat, test } from './helpers/structured-claude-stub'

test.describe('native chat plugin UI frames', () => {
  test.skip(!SUPPORTED, 'the Claude stub wrapper is POSIX-only')

  test('a focused plugin pane fails once and a follow-up completes on a fresh process', async ({
    orcaPage: page,
    claudeStub
  }) => {
    const { reply, composer } = await openStubChat(page, claudeStub.command)
    await page.keyboard.type('plugin-focus probe')
    await page.keyboard.press('Enter')
    const chat = page.locator('[data-native-chat-root="true"]')
    await expect(chat.getByText(/Claude stopped because the "blast-radius" plugin/)).toHaveCount(
      1,
      { timeout: 30_000 }
    )
    await composer.fill('recovery probe')
    await composer.press('Enter')
    await expect(reply).toBeVisible({ timeout: 30_000 })
    const requests = readFileSync(`${claudeStub.launchLog}.requests.jsonl`, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    const sends = requests.filter((request) => request.type === 'user')
    expect(new Set(sends.map((request) => request.pid)).size).toBe(2)
  })
})
