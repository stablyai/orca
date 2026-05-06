/**
 * E2E coverage for sibling chats sharing one worktree.
 *
 * Why click-based switching: Cmd/Ctrl+1-9 is intercepted by the main process
 * (window-shortcut-policy.ts) and forwarded to the renderer as
 * `ui:jumpToWorktreeIndex`. Playwright's renderer-level keyboard.press never
 * reaches the main intercept, so the click path is the reliable e2e harness
 * for chat switching. The keyboard-shortcut path is exercised by
 * useIpcEvents.test.ts at the unit level.
 */

import { test, expect } from './helpers/orca-app'
import {
  waitForSessionReady,
  waitForActiveWorktree,
  ensureTerminalVisible,
  getActiveWorktreeId
} from './helpers/store'
import { waitForActiveTerminalManager } from './helpers/terminal'

const CHAT_SWITCHER = '[data-testid="chat-switcher"]'
const CHAT_ITEM = '[data-testid="chat-switcher-item"]'

test.describe('Multi-chat per worktree', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage)
  })

  test('hides switcher with one chat, shows it with two, toggles active state on click, persists across reload', async ({
    orcaPage
  }) => {
    const worktreeId = (await getActiveWorktreeId(orcaPage))!

    // Single-chat worktrees have the switcher hidden entirely.
    await expect(orcaPage.locator(CHAT_SWITCHER)).toHaveCount(0)

    await orcaPage.evaluate(async (worktreeId) => {
      await window.__store!.getState().createChat(worktreeId)
    }, worktreeId)

    await expect(orcaPage.locator(CHAT_SWITCHER)).toBeVisible()
    await expect(orcaPage.locator(CHAT_ITEM)).toHaveCount(2)
    // createChat activates the new chat.
    await expect(orcaPage.locator(CHAT_ITEM).nth(1)).toHaveAttribute('data-active', 'true')

    // Click the first chat — active state should toggle.
    await orcaPage.locator(CHAT_ITEM).nth(0).click()
    await expect(orcaPage.locator(CHAT_ITEM).nth(0)).toHaveAttribute('data-active', 'true')
    await expect(orcaPage.locator(CHAT_ITEM).nth(1)).toHaveAttribute('data-active', 'false')

    // Click the second chat — state toggles back.
    await orcaPage.locator(CHAT_ITEM).nth(1).click()
    await expect(orcaPage.locator(CHAT_ITEM).nth(1)).toHaveAttribute('data-active', 'true')
    await expect(orcaPage.locator(CHAT_ITEM).nth(0)).toHaveAttribute('data-active', 'false')

    // Persistence: the chat list survives a reload (mid-hydrate guard ensures
    // the persisted active chat id is preserved while metadata reloads).
    await orcaPage.reload()
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await expect(orcaPage.locator(CHAT_ITEM)).toHaveCount(2)
  })
})
