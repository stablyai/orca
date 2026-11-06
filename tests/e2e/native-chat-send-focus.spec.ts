// Completed tab and composer actions return keyboard input to the chat draft.

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
      nativeChatProviders: { claude: true, codex: true },
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
  const tab = page.locator(`[data-testid="sortable-tab"][data-tab-id="${await readTabId()}"]`)
  await tab.click()
  const chat = page.locator('[data-native-chat-root="true"]')
  const composer = chat.getByRole('textbox')
  await composer.click()
  return {
    tab,
    composer,
    send: chat.getByRole('button', { name: 'Send', exact: true }),
    stop: chat.getByRole('button', { name: 'Stop the agent' }),
    reply: chat.getByText('Stub reply.')
  }
}

test.describe('native chat composer focus', () => {
  test.skip(!SUPPORTED, 'the Claude stub wrapper is POSIX-only')

  test('quick launcher keeps focus when Copy Context completes', async ({
    electronApp,
    orcaPage: page,
    claudeStub
  }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    const { composer, send, reply } = await openChat(page, claudeStub.command)
    await page.keyboard.type('hello')
    await send.click()
    await expect(reply).toBeVisible({ timeout: 30_000 })
    await electronApp.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('clipboard:writeTerminalText')
      ipcMain.handle(
        'clipboard:writeTerminalText',
        () =>
          new Promise<void>((resolve) => {
            const gate: { pid: number; releaseContextCopy?: () => void } = process
            gate.releaseContextCopy = resolve
          })
      )
    })
    await reply.click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Copy Context', exact: true }).click()
    await expect
      .poll(() =>
        electronApp.evaluate(() => {
          const gate: { pid: number; releaseContextCopy?: () => void } = process
          return typeof gate.releaseContextCopy === 'function'
        })
      )
      .toBe(true)
    await page.getByRole('button', { name: 'New tab', exact: true }).click()
    const menu = page.getByRole('menu', { name: 'New tab', exact: true })
    const search = menu.getByRole('combobox')
    await expect(search).toBeFocused()

    await electronApp.evaluate(() => {
      const gate: { pid: number; releaseContextCopy?: () => void } = process
      gate.releaseContextCopy?.()
    })

    await expect(page.getByText('Context copied', { exact: true })).toBeVisible()
    await expect(menu).toBeVisible()
    await expect(search).toBeFocused()
    await page.keyboard.type('terminal')
    await expect(search).toHaveValue('terminal')
    await expect(composer).toHaveText('')
    await page.screenshot({ path: testInfo.outputPath('quick-launch-focus.png') })
  })

  test('keyboard tab rename returns input to the native chat composer', async ({
    orcaPage: page,
    claudeStub
  }) => {
    const { tab, composer } = await openChat(page, claudeStub.command)
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
