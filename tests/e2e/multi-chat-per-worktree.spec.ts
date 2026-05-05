/**
 * E2E coverage for sibling chats sharing one worktree.
 */

import { test, expect } from './helpers/orca-app'
import {
  waitForSessionReady,
  waitForActiveWorktree,
  ensureTerminalVisible,
  getActiveWorktreeId
} from './helpers/store'
import {
  discoverActivePtyId,
  execInTerminal,
  getTerminalContent,
  waitForActiveTerminalManager
} from './helpers/terminal'

const CHAT_ITEM = '[data-testid="chat-switcher-item"]'

test.describe('Multi-chat per worktree', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage)
  })

  test('creates, switches, isolates scrollback, shares pwd, and survives reload', async ({
    orcaPage
  }) => {
    const worktreeId = (await getActiveWorktreeId(orcaPage))!
    const worktreePath = await orcaPage.evaluate((worktreeId) => {
      const state = window.__store!.getState()
      return Object.values(state.worktreesByRepo)
        .flat()
        .find((entry) => entry.id === worktreeId)!.path
    }, worktreeId)

    await orcaPage.evaluate(async (worktreeId) => {
      await window.__store!.getState().createChat(worktreeId)
    }, worktreeId)

    await expect(orcaPage.locator(CHAT_ITEM)).toHaveCount(2)
    await expect(orcaPage.locator(CHAT_ITEM).nth(1)).toHaveAttribute('data-active', 'true')
    await expect(orcaPage.locator('[data-testid="chat-switcher"]')).toBeVisible()

    const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
    await orcaPage.keyboard.press(`${mod}+1`)
    await expect(orcaPage.locator(CHAT_ITEM).nth(0)).toHaveAttribute('data-active', 'true')
    const chatOnePty = await discoverActivePtyId(orcaPage)
    await execInTerminal(orcaPage, chatOnePty, 'echo CHAT_ONE_MARKER')
    await execInTerminal(orcaPage, chatOnePty, 'pwd')
    await expect
      .poll(() => getTerminalContent(orcaPage), { timeout: 10_000 })
      .toContain(worktreePath)

    await orcaPage.keyboard.press(`${mod}+2`)
    await expect(orcaPage.locator(CHAT_ITEM).nth(1)).toHaveAttribute('data-active', 'true')
    const chatTwoPty = await discoverActivePtyId(orcaPage)
    await execInTerminal(orcaPage, chatTwoPty, 'echo CHAT_TWO_MARKER')
    await execInTerminal(orcaPage, chatTwoPty, 'pwd')
    await expect
      .poll(() => getTerminalContent(orcaPage), { timeout: 10_000 })
      .toContain(worktreePath)
    await expect
      .poll(() => getTerminalContent(orcaPage), { timeout: 10_000 })
      .toContain('CHAT_TWO_MARKER')
    expect(await getTerminalContent(orcaPage)).not.toContain('CHAT_ONE_MARKER')

    await orcaPage.keyboard.press(`${mod}+1`)
    await expect
      .poll(() => getTerminalContent(orcaPage), { timeout: 10_000 })
      .toContain('CHAT_ONE_MARKER')
    expect(await getTerminalContent(orcaPage)).not.toContain('CHAT_TWO_MARKER')

    await orcaPage.reload()
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await expect(orcaPage.locator(CHAT_ITEM)).toHaveCount(2)
  })
})
