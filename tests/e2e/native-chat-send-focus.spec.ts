// Clicking Send or Stop leaves focus in the composer, as Enter does, after the button disables.

import type { Locator, Page } from '@stablyai/playwright-test'
import { expect } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { buildFakeAgentCommandOverride } from './helpers/fake-agent-command-override'
import { SUPPORTED, createChatOnHost, test } from './helpers/structured-claude-stub'

function focusIsIn(composer: Locator): Promise<boolean> {
  return composer.evaluate((element) => element.contains(element.ownerDocument.activeElement))
}

async function openChat(page: Page, claudeCommand: string) {
  await waitForSessionReady(page)
  const worktreeId = await waitForActiveWorktree(page)
  await page.evaluate(async (command) => {
    await window.__store?.getState().updateSettings({
      experimentalNativeChat: true,
      defaultTuiAgent: 'claude',
      agentCmdOverrides: { claude: command }
    })
  }, buildFakeAgentCommandOverride(claudeCommand))
  const sessionId = await createChatOnHost(page, worktreeId)
  const readTabId = () =>
    page.evaluate(
      ({ worktreeId, sessionId }) =>
        window.__store
          ?.getState()
          .unifiedTabsByWorktree[worktreeId]?.find((tab) => tab.entityId === sessionId)?.id,
      { worktreeId, sessionId }
    )
  await expect.poll(readTabId, { timeout: 30_000 }).toBeTruthy()
  await page.locator(`[data-testid="sortable-tab"][data-tab-id="${await readTabId()}"]`).click()
  const chat = page.locator('[data-native-chat-root="true"]')
  const composer = chat.getByRole('textbox')
  await composer.click()
  return {
    composer,
    send: chat.getByRole('button', { name: 'Send', exact: true }),
    stop: chat.getByRole('button', { name: 'Stop the agent' }),
    reply: chat.getByText('Stub reply.')
  }
}

test.describe('a click on the native chat composer button keeps focus in the composer', () => {
  test.skip(!SUPPORTED, 'the Claude stub wrapper is POSIX-only')

  test('when Send disables at the end of the turn', async ({ orcaPage: page, claudeStub }) => {
    const { composer, send, stop, reply } = await openChat(page, claudeStub.command)
    await page.keyboard.type('hello')
    await send.click()
    await expect(reply).toBeVisible({ timeout: 30_000 })
    await expect(stop).toHaveCount(0)
    await expect.poll(() => focusIsIn(composer)).toBe(true)
  })

  test('when Stop disables while the stop is in flight', async ({ orcaPage: page, claudeStub }) => {
    const { composer, send, stop } = await openChat(page, claudeStub.command)
    // The stub runs a prompt containing "slow" until it is interrupted.
    await page.keyboard.type('slow')
    await send.click()
    await stop.click()
    await expect(stop).toHaveCount(0, { timeout: 30_000 })
    await expect.poll(() => focusIsIn(composer)).toBe(true)
  })
})
