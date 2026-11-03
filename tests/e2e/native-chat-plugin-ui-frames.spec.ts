// A Claude plugin's status line and toasts never reach the chat transcript as raw provider rows.

import { readFileSync } from 'node:fs'
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
    await expect(chat.getByText('PR 6 · 진행 13 · 대기 6', { exact: false })).toHaveCount(0)
    await expect(chat.getByText('Board synced')).toHaveCount(0)
    await expect(reply).toBeVisible()
  })

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
    const launches = readFileSync(claudeStub.launchLog, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    const sessions = launches.filter((launch) => launch.args.includes('--input-format'))
    expect(new Set(sessions.map((launch) => launch.pid)).size).toBe(2)
  })
})
